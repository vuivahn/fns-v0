# SQLite Store 운영 가이드

## 경계

`SQLiteStore`는 `FnsStore` v0의 네 read API만 구현합니다. 데이터 입력, scope별 coverage 선언, 백업, 무결성 검사는 `SQLiteStoreAdmin`의 관리 표면이며 Store Interface v0의 공개 read 계약이 아닙니다.

저장 대상은 canonical ObjectId와 strict JSON 값입니다. SQLiteStore는 raw 객체의 payload를 검증하거나 FNS 객체로서의 유효성·신뢰성·release 상태를 판단하지 않습니다. 다만 discovery를 위해 raw payload에서 아래 파생 인덱스를 계산합니다.

| 조회             | 인덱스 조건                                                           |
| ---------------- | --------------------------------------------------------------------- |
| alias binding    | `payload.type`, `payload.context`, `payload.alias`                    |
| alias release    | `payload.type`, `payload.binding`                                     |
| commune document | genesis의 `objectId`, 또는 update의 `payload.type`, `payload.commune` |

인덱스와 저장된 canonical JSON이 일치하지 않으면 read와 `verifyIntegrity()`는 `StoreIntegrityError`로 실패합니다.

## 데이터 수명주기

1. `new SQLiteStore({ filename, source, snapshot })`는 새 데이터베이스를 schema v1로 만들고 WAL 모드를 켭니다.
2. `admin.importSnapshot({ entries, coverage, source, snapshot })`는 `BEGIN IMMEDIATE` transaction 안에서 snapshot을 교체하거나(`replace: true`, 기본값) 추가합니다(`replace: false`).
3. 각 snapshot 또는 append는 data revision을 증가시키고 기존 coverage를 무효화합니다.
4. coverage는 정확한 메서드·scope·revision 조합에만 적용됩니다. 선언되지 않은 scope는 항상 `complete: false`입니다.
5. Store read API는 현재 revision의 coverage, provenance, warning을 envelope에 담아 반환합니다.

`findAliasReleases`는 SQLite 변수 제한을 넘지 않도록 binding ID를 900개 단위로 조회합니다.

## 관리 API

```js
const admin = new SQLiteStoreAdmin(store);

admin.importSnapshot({ entries, coverage, source, snapshot, replace: true });
admin.appendEntries(entries);
admin.setCoverage("bindings", { context, alias }, true);
admin.setCoverage("releases", { bindingIds }, true);
admin.setCoverage("communeDocuments", { context }, true);

const report = admin.verifyIntegrity();
await admin.backup("./backups/fns.sqlite");
```

`importSnapshot`, `appendEntries`, `setCoverage`, `verifyIntegrity`는 동기 관리 작업입니다. `backup`은 SQLite online backup API를 사용하므로 Promise를 반환합니다. 운영 도구에서는 backup Promise를 반드시 `await`하고 실패를 경고로 처리해야 합니다.

## 백업과 복구

1. 쓰기 가능한 Store에서 `await admin.backup(destination)`으로 별도 SQLite 파일을 만듭니다.
2. 백업 파일을 격리된 위치에 복사하고, 암호화·접근 제어·보존 기간은 배포 환경의 정책으로 적용합니다.
3. 정기적으로 `new SQLiteStore({ filename: destination, readonly: true })`를 열고 `new SQLiteStoreAdmin(store).verifyIntegrity()` 및 필요한 discovery query를 실행해 복구 가능성을 확인합니다.
4. 복구 시에는 서비스 프로세스를 중지하거나 새 파일로 교체한 뒤 read-only 검증을 거쳐 읽기 트래픽을 전환합니다.

이 저장소는 단일 노드 SQLite 구현입니다. 다중 인스턴스 write, 지역 간 복제, 자동 failover가 필요하면 Relay v1과 함께 별도의 저장소 토폴로지 결정을 내려야 합니다.

## 오류와 대응

| 오류                      | 의미                                          | 운영 대응                                           |
| ------------------------- | --------------------------------------------- | --------------------------------------------------- |
| `E_STORE_INVALID_REQUEST` | 형식이 잘못된 ObjectId·scope·관리 입력        | 호출자 입력을 수정하고 재시도하지 않음              |
| `E_STORE_ACCESS`          | 파일·잠금·권한·I/O·닫힌 Store 문제            | 파일 권한, 잠금, 디스크, 백업 경로를 확인           |
| `E_STORE_INTEGRITY`       | schema, JSON, ObjectId, 파생 인덱스 충돌/손상 | 쓰기를 중단하고 마지막 정상 backup으로 복구 전 검증 |

Store가 `complete: false`를 반환한 것은 오류가 아닙니다. 관측 범위가 완전하다고 증명되지 않았다는 뜻이므로, 이를 빈 결과나 무효 결과로 바꾸면 안 됩니다.

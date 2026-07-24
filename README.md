# FNS Store Interface v0

FNS Core v0와 저장·전송 환경 사이의 비동기, 읽기 전용 후보 발견 경계에 대한 참조 구현입니다. Store는 검증되지 않은 JSON 후보와 관측 정보를 제공할 뿐, 객체 유효성·release 상태·capability·fork·conflict·로컬 신뢰를 판단하지 않습니다.

현재 저장소는 서버나 Relay가 아니라 Node.js 라이브러리입니다. Relay 프로토콜, 인증, pagination, federation, ranking, trust policy는 동결된 v0 범위 밖입니다.

## 제공 범위

- Node.js 20 이상 지원
- `FnsStore`의 네 async read API와 `MemoryStore` 참조 구현
- 파일 기반 영속 구현인 `SQLiteStore`와 별도 관리 API `SQLiteStoreAdmin`
- canonical ObjectId, strict JSON 값 경계, 코드포인트 기반 결정적 정렬, defensive copy
- `discoverFromStore`와 `resolveAliasFromStore` async adapter
- MemoryStore·SQLiteStore 공통 적합성 테스트, lint·format·coverage·감사 CI

자세한 계약은 [Store Interface v0 Plan](STORE-INTERFACE-V0-PLAN.md), 동결 범위는 [Store Interface v0 Freeze](STORE-INTERFACE-V0-FREEZE.md)를 참고하세요.

## 시작하기

```text
npm ci
npm test
```

PowerShell에서 `npm` shim 실행 정책 문제가 있으면 `npm.cmd test`처럼 실행합니다.

```js
const { MemoryStore, discoverFromStore, resolveAliasFromStore } = require("fns-store-interface-v0");

const store = new MemoryStore({ source: "memory:example" });
// store.put(...) is fixture/reference-store setup only.

const discovery = await discoverFromStore({ context, alias }, store);
const result = await resolveAliasFromStore({ context, alias }, store);
```

`FnsStore` 구현은 `getObject`, `findAliasBindings`, `findAliasReleases`, `findCommuneDocuments`를 Promise로 제공해야 합니다. 각 discovery 결과의 `complete`, `provenance`, `warnings`는 메서드와 요청 scope별로 보존해야 합니다.

## SQLite 영속 Store

`SQLiteStore`의 공개 Store 표면은 읽기 전용입니다. 스냅샷 가져오기, completeness 설정, 백업, 무결성 검사는 동결된 v0 계약을 넓히지 않도록 `SQLiteStoreAdmin`에 분리했습니다.

```js
const { SQLiteStore, SQLiteStoreAdmin } = require("fns-store-interface-v0");

const store = new SQLiteStore({
  filename: "./data/fns.sqlite",
  source: "sqlite:local-fixture",
  snapshot: "2026-07-24T00:00:00Z"
});
const admin = new SQLiteStoreAdmin(store);

admin.importSnapshot({
  entries: [{ objectId, object }],
  coverage: [
    { method: "bindings", scope: { context, alias }, complete: true },
    { method: "releases", scope: { bindingIds: [bindingId] }, complete: true },
    { method: "communeDocuments", scope: { context }, complete: true }
  ]
});

const result = await store.findAliasBindings(context, alias);
await admin.backup("./backups/fns.sqlite");
store.close();
```

- 새 데이터베이스는 schema migration과 WAL 모드로 초기화됩니다. 이미 존재하는 데이터베이스의 `source`·`snapshot`은 보존하며, 새 값은 `importSnapshot`에서 설정합니다.
- coverage가 없는 scope는 안전하게 `complete: false`입니다. `appendEntries` 또는 새 snapshot은 이전 coverage를 무효화합니다.
- 같은 ObjectId에 서로 다른 canonical JSON 표현을 넣으면 `StoreIntegrityError`가 발생합니다. FNS 객체 자체의 유효성은 판단하지 않습니다.
- 읽기 전용 복구 확인은 `new SQLiteStore({ filename, readonly: true })`로 수행합니다.

운영 절차와 관리 API의 상세는 [SQLite Store 운영 가이드](SQLITE-STORE.md)에 있습니다.

## 개발 및 품질 게이트

```text
npm run check          # ESLint + Prettier 확인
npm run test:strict    # Node strict unhandled rejection 테스트
npm run coverage       # c8 임계값: line/statement 90, function 85, branch 75
npm run audit:prod     # production dependency high 이상 취약점 검사
npm run package:check  # npm package dry-run
```

GitHub Actions는 Node.js 20·22·24에서 check, strict test, package dry-run을 실행하고 Node 20에서 coverage와 production audit을 별도 실행합니다. Dependabot은 npm 및 GitHub Actions 의존성을 매주 점검합니다.

`Dockerfile.ci`는 포트·시크릿·영속 볼륨 없이 strict test만 실행하는 비-root 검증 컨테이너입니다. Docker가 설치된 환경에서 다음과 같이 확인할 수 있습니다.

```text
docker build -f Dockerfile.ci -t fns-store-interface-v0-ci .
docker run --rm fns-store-interface-v0-ci
```

## Relay와 운영 배포

Relay는 이 패키지에 추가하지 않습니다. 별도 `relay-v1` 서비스로 분리하고, v0의 네 read API 및 discovery envelope를 투명하게 전달해야 합니다. 인증 방식, 클라우드·TLS 경계, 저장소 토폴로지, RPO/RTO, 데이터 분류·보존, wire format, 라이선스가 결정되기 전에는 실제 Relay나 공개 배포를 진행하지 않습니다.

준비된 경계와 의사결정 목록은 [Relay v1 RFC 초안](RELAY-V1-RFC.md), 전체 진행 상태와 다음 단계는 [Infrastructure Roadmap](INFRASTRUCTURE-ROADMAP.md)에 정리했습니다.

## 라이선스

아직 라이선스가 선택되지 않았습니다. 공개 배포 또는 npm 배포 전에 저장소 소유자가 명시적인 라이선스를 추가해야 합니다.

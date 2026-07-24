# Store Interface v0 Plan

## 목적과 경계

Store Interface v0는 동결된 FNS Core v0와 저장·전송 환경 사이의 비동기 read-only 경계다. Store는 검증되지 않은 후보 객체와 관측 정보를 제공할 뿐, 객체 유효성·release 상태·capability·fork·conflict·local trust를 판단하지 않는다.

이 문서는 `MemoryStore`, `SQLiteStore`, 그리고 Core를 변경하지 않는 async adapter가 구현하는 계약을 기록한다. SQLiteStore의 snapshot·backup·무결성 관리 표면은 별도 `SQLiteStoreAdmin`에 있으며, Relay와 DirectoryStore는 이 계약을 구현할 후속 adapter다.

## 표준 타입

```js
// Store가 반환하는 후보. object는 유효성 여부와 무관한 JSON 값이다.
{ objectId: ObjectId, object: JsonValue }

// discovery 메서드의 반환값
{
  version: "fns.store-discovery.v0",
  objects: Candidate[],
  complete: boolean,
  provenance: Provenance[],
  warnings: Diagnostic[]
}
```

모든 `objects` 배열은 `objectId` 코드포인트 오름차순이다. `warnings`는 `code`, 그 뒤 안정된 `detail` 표현 순으로 정렬한다. 이 정렬은 locale-aware 비교가 아니라 코드포인트 비교로 구현한다. 후보와 envelope의 값은 JSON 값이어야 하므로 `undefined`, `NaN`·무한대, 함수, `BigInt`, `Date`, 순환 참조는 허용하지 않는다. Store는 payload의 JCS, ObjectId 유도, 서명 또는 스키마를 검증하지 않는다.

`ObjectId`는 `fns:obj:sha256:` 뒤에 43개의 base64url 문자가 오는 문자열이다. 접미사는 정확히 32바이트로 decode되고 동일한 base64url 문자열로 다시 encode되어야 한다. 따라서 마지막 문자의 미사용 padding bit도 0이어야 한다. alias는 문자열로만 검사하며 정규화하거나 별칭 문법의 유효성을 판단하지 않는다.

## FnsStore read API

```js
class FnsStore {
  async getObject(objectId) {} // Candidate | null
  async findAliasBindings(context, alias) {} // DiscoveryEnvelope
  async findAliasReleases(bindingIds) {} // DiscoveryEnvelope
  async findCommuneDocuments(context) {} // DiscoveryEnvelope
}
```

`MemoryStore`는 이 추상 클래스를 구현한다. 다른 구현은 상속을 요구받지 않지만 동일한 async 메서드 계약을 충족해야 한다.

- 모든 메서드는 Promise를 반환하며 Store 상태를 변경하지 않는다.
- `getObject`의 `null`은 해당 식별자가 현재 관측 범위에서 발견되지 않았음을 뜻한다. 접근 실패는 `null`이 아니라 오류다.
- `findAliasReleases`는 배열 입력을 중복 제거한 뒤 ObjectId 순으로 처리한다. 빈 배열은 빈 결과를 반환한다.
- `findCommuneDocuments(context)`는 Genesis 후보(`objectId === context`)와 `payload.type === "fns.commune.update"` 및 `payload.commune === context`인 Update 후보를 반환한다. 이는 후보 인덱싱일 뿐 유효성 판정이 아니다.

## completeness와 provenance

`complete`는 전역 Store 속성이 아니라 **메서드·요청·provenance scope별** 속성이다. `complete: true`는 provenance가 표현한 source/snapshot/scope 안에서 그 메서드가 모든 후보를 탐색했다는 뜻이다. 한 메서드의 완전성은 다른 메서드의 불완전을 덮지 않는다.

```js
{
  source: "memory:fixture-a",
  snapshot: "fixture-1", // 없으면 null
  scope: { context, alias },
  complete: true
}
```

`complete: false`는 발견된 객체가 거짓이라는 뜻도, 전역 부재의 증명도 아니다. 관측 범위의 제한을 뜻하며 `W_STORE_DISCOVERY_INCOMPLETE`를 함께 보고한다. Provenance는 객체의 진실성·신뢰성·우선순위를 주장하지 않는다.

## 중복, 스냅샷, 오류

Store는 동일 ObjectId의 동일 **저장 표현**을 하나의 후보로 정규화한다. 동일 ObjectId에 서로 다른 JSON 저장 표현이 있으면 `StoreIntegrityError`다. 이 비교는 저장소 무결성 검사일 뿐 JCS나 FNS ObjectId 검증이 아니다.

반환 후보와 envelope는 호출 시점의 방어적 JSON 복사본이다. 호출자가 결과를 변경해도 Store 내부 상태는 변하지 않는다.

- `InvalidRequestError` (`E_STORE_INVALID_REQUEST`): 형식이 잘못된 ObjectId 또는 메서드 인수
- `StoreAccessError` (`E_STORE_ACCESS`): 권한·I/O·네트워크 등으로 조회 자체를 수행하지 못함
- `StoreIntegrityError` (`E_STORE_INTEGRITY`): 하나의 ObjectId에 상충하는 저장 표현

부분 관측처럼 계약을 유지한 채 일부 후보를 반환할 수 있는 상태는 오류가 아니라 `complete: false`와 warnings다.

## MemoryStore

`MemoryStore`는 FnsStore의 참조 구현이다. `put({ objectId, object })` 및 `setCompleteness(method, boolean)`은 테스트·fixture 구성용 관리 API이며, 일반 FnsStore read surface에는 포함되지 않는다.

- malformed-but-addressable 객체는 `getObject`로 보관·조회할 수 있다.
- type·인덱스 필드가 없는 객체는 discovery 인덱스에 넣지 않는다.
- 결함 있는 AliasBind/Release/Commune 후보도 식별 가능한 raw payload 필드를 갖는 한 discovery에 포함할 수 있다.
- 삽입 순서는 모든 read 결과의 순서에 영향을 주지 않는다.

## Resolution adapter

`discoverFromStore(query, store)`는 query와 Store 메서드 존재 여부를 먼저 검증하고, 세 discovery envelope를 독립적으로 수집해 후보를 ObjectId 키의 평면 object store로 만든다. Store가 잘못된 envelope·Candidate·진단을 반환하면 `StoreIntegrityError`로 실패하며, 동시 조회의 실패는 함께 관찰해 unhandled rejection을 남기지 않는다.

`resolveAliasFromStore(query, store, options)`는 다음을 반환한다.

```js
{
  version: "fns.store-resolution.v0",
  resolution,       // 동결된 fns-v0-validator resolveAlias 결과
  storeDiscovery: { bindings, releases, communeDocuments },
  warnings
}
```

adapter는 동결된 동기 `resolveAlias`의 입력·출력·의미를 변경하지 않는다. Core `resolution.discovery.complete`에는 binding discovery의 완전성만 전달하고, 세 메서드의 완전성·provenance·warnings는 `storeDiscovery`에 독립적으로 보존한다. 따라서 release 또는 Commune discovery의 불완전성을 binding 완전성으로 감추지 않는다.

## 적합성 벡터와 구현 순서

`npm test`는 다음을 고정한다.

- 동치 중복의 idempotence, 상충 ObjectId의 integrity 오류
- malformed-but-addressable 및 unindexed 후보 취급
- canonical ObjectId, JSON 경계, 코드포인트 기반 결정적 정렬과 방어적 복사
- `getObject` miss와 잘못된 요청의 구분
- binding/release/Commune 완전성의 독립성 및 provenance/warnings 보존
- async adapter의 query/envelope 검증, falsy 후보 충돌, 병렬 실패 관찰 및 Core 결과의 별도 projection 보존

구현 순서는 Store result 타입 → FnsStore read API → MemoryStore → async adapter → 정상·부정 벡터 → 동결이다.

## v0 제외 범위

- 쓰기, 삭제, 동기화, 구독, 트랜잭션 API
- pagination, streaming, cursor 표준화
- relay 전송 프로토콜, 인증, provenance 서명
- 캐시 일관성, federation, 다중 Store 병합
- ranking, trust policy, conflict 해결
- 동결된 AliasBinding·CommuneDocument·Resolution Layer의 의미 변경

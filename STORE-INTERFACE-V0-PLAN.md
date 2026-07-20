# Store Interface v0 Plan

## 1. 목적과 비목표

Store Interface v0는 FNS Core와 외부 저장·전송 환경 사이의 첫 공식 경계다. Store는 Core가 검증하고 해석할 **후보 객체**를 읽기 전용으로 발견해 제공한다. 저장소의 구조, 전송 방식, 동기화 범위는 Store 뒤에 숨기되 FNS의 의미 판단은 숨기지 않는다.

v0의 목적은 다음과 같다.

- 후보 객체의 비동기적 read-only discovery 계약을 고정한다.
- 각 discovery의 관측 범위, 완전성, 출처를 Core에 전달한다.
- ObjectId 기준의 중복 처리와 조회 결과의 결정성을 보장한다.
- MemoryStore를 참조 구현으로 제공해 이후 저장소 어댑터의 행동 기준을 만든다.

Store는 FNS 의미를 결정하지 않는다. 특히 객체 유효성, release 상태, capability, fork 승자, alias conflict, local trust는 Store의 책임이 아니다.

## 2. Store Interface의 책임 경계

Store의 책임:

- 요청 조건에 맞춰 발견한 후보 객체를 반환한다.
- 각 발견 결과의 관측 범위와 출처를 설명한다.
- 같은 ObjectId의 동치 중복을 정규화한다.
- 결정적 순서를 제공하거나 그 순서 책임을 명시한다.
- 저장소 또는 전송 계층의 실패와 discovery 불완전을 구분해 보고한다.

Store가 하지 않는 일:

- 객체 서명·스키마·참조 관계 등의 유효성 판정
- release가 활성·폐기·만료되었는지의 판정
- capability 또는 권한 판정
- fork winner 선택과 alias conflict 해소
- local trust, policy, preference의 적용

## 3. 비동기 read-only API

초기 인터페이스는 다음과 같다.

```js
class FnsStore {
  async getObject(objectId) {}

  async findAliasBindings(context, alias) {}

  async findAliasReleases(bindingIds) {}

  async findCommuneDocuments(context) {}
}
```

모든 메서드는 Promise를 반환하며 호출자나 저장소 상태를 변경하지 않는다. `getObject`는 단일 객체 조회이고, 나머지는 discovery 메서드다. API는 객체가 이미 유효하거나 신뢰할 수 있다고 가정해서는 안 된다.

## 4. 반환 객체와 ObjectId 계약

Discovery 메서드는 단순 배열 대신 discovery envelope를 반환한다.

```js
{
  objects: [],
  complete: false,
  provenance: [],
  warnings: []
}
```

- `objects`: 발견된 후보 객체의 결정적 배열이다. malformed 객체도 포함할 수 있다.
- `complete`: 이 메서드와 이 요청 범위 안에서 Store가 알고 있는 모든 후보를 제공했는지 나타낸다.
- `provenance`: 결과 또는 관측 범위의 출처 설명이다.
- `warnings`: 실패가 아닌 제한, 부분 관측, 비정상 데이터 등의 진단 정보다.

`ObjectId`는 객체를 식별하는 정규화된 문자열이며 동일한 ObjectId는 동일한 정규 객체 내용을 뜻한다. Store는 ObjectId가 유효한 FNS 객체를 가리킨다는 의미 판단을 하지 않는다. 다만 API 경계에서 ObjectId 문자열 형식이 계약상 요구되는 경우 잘못된 요청 식별자는 명시적 오류로 거부한다.

`getObject(objectId)`는 객체를 찾지 못했을 때 `null`을 반환할 수 있다. 저장소 접근 자체가 불완전하거나 실패한 경우에는 `null`과 discovery 결과를 혼동하지 말고 오류 또는 별도 상태로 알려야 한다.

## 5. discovery completeness

완전성은 전역 Store 속성이 아니라 **메서드별, 요청별** 속성이다. binding discovery가 완전해도 release discovery는 불완전할 수 있다.

```js
{
  bindings: {
    objects: [],
    complete: true
  },
  releases: {
    objects: [],
    complete: false
  }
}
```

v0에서는 각 discovery 메서드가 독립적인 envelope를 반환한다. Resolution Layer는 필요한 모든 discovery 결과의 `complete`를 독립적으로 고려해야 하며, 하나의 완전한 결과로 다른 결과의 불완전을 덮어서는 안 된다.

`complete: false`는 결과가 거짓이라는 뜻이 아니다. 현재 관측 범위에서 발견된 후보는 반환되었지만, 존재할 수 있는 모든 후보가 발견되었음을 Store가 보장할 수 없다는 뜻이다.

## 6. provenance 표현

`provenance`는 Core가 결과의 관측 경로와 제한을 설명할 수 있게 하는 읽기 전용 메타데이터다. 최소한 다음을 표현할 수 있어야 한다.

- 관측한 저장소·피어·스냅샷 등 출처 식별자
- 관측 시점 또는 스냅샷 식별자
- 적용한 범위·필터·cursor
- 완전성을 제한한 사유

표현 형식은 v0에서 확장 가능한 plain object 배열로 둔다.

```js
{
  source: "memory:fixture-a",
  observedAt: "2026-07-20T00:00:00.000Z",
  scope: { context, alias },
  complete: true
}
```

Provenance는 객체의 진실성이나 신뢰도를 주장하지 않는다. 그 판단은 Resolution Layer와 policy에 남는다.

## 7. 중복 객체 처리

Store는 같은 ObjectId를 가진 동일 내용의 중복 객체를 한 번만 반환한다. 같은 ObjectId에 서로 다른 정규화 내용이 연결되면 이는 의미상 해소할 수 없는 저장소 무결성 문제이므로 명시적 오류로 처리한다.

객체의 유효성과 중복 동치 판정은 분리한다. malformed 객체라도 주소 지정이 가능하고 동일한 원시 표현으로 식별할 수 있으면 보관·반환할 수 있다. Store는 이를 validator보다 먼저 폐기하지 않는다.

## 8. 결정적 정렬 책임

동일한 Store 상태와 동일한 요청은 입력·삽입 순서와 무관하게 동일한 객체 순서를 반환해야 한다. v0의 기본 순서는 ObjectId의 코드포인트 오름차순이다.

향후 백엔드가 이 순서를 직접 보장하기 어렵다면 어댑터가 반환 전 정렬해야 한다. Resolution Layer는 Store의 배열 순서를 fork winner 선택이나 의미적 우선순위로 해석해서는 안 된다.

## 9. 오류 모델

오류는 다음 범주를 구분한다.

- `InvalidRequestError`: 잘못된 ObjectId나 메서드 계약을 위반한 인수
- `StoreAccessError`: 저장소·네트워크·권한 등으로 조회를 수행하지 못함
- `StoreIntegrityError`: 같은 ObjectId에 상충하는 내용이 존재함

부분 관측, 선택적 source 실패, 지원하지 않는 최적화 경로처럼 결과 일부를 제공할 수 있는 상태는 envelope의 `complete: false`와 `warnings`로 보고한다. Store가 결과를 신뢰할 수 없거나 계약을 유지할 수 없을 때는 오류를 던진다.

## 10. MemoryStore 참조 구현

MemoryStore는 v0 계약의 기준 구현이다.

- 같은 ObjectId와 같은 내용의 반복 삽입은 idempotent하다.
- 같은 ObjectId와 다른 내용의 삽입은 `StoreIntegrityError`다.
- 타입과 인덱싱에 필요한 필드가 없는 객체도 원시 ObjectId로 주소 지정 가능하면 보관한다.
- 인덱스를 만들 수 없을 정도로 구조가 깨진 객체는 unindexed bucket에 보관하고 `getObject`로 접근 가능하게 한다.
- alias binding, alias release, commune document는 타입별 인덱스를 통해 찾되, 후보의 유효성을 판정하지 않는다.
- 조회 배열은 결정적으로 정렬한다.
- 저장 시 불변 스냅샷 또는 방어적 복사를 사용하고, 반환 시에도 호출자가 내부 상태를 변경할 수 없게 한다.

MemoryStore의 `complete`는 메모리에 등록된 해당 인덱스 범위를 모두 탐색했을 때 `true`다. 테스트에서 부분 관측을 표현할 수 있도록 source 또는 결과 범위의 completeness를 설정하는 훅을 제공할 수 있다.

## 11. Resolution Layer 연결

Resolution Layer는 Store에서 받은 후보를 다음 순서로 다룬다.

1. 필요한 discovery를 독립적으로 호출한다.
2. 각 envelope의 `objects`를 validator에 전달한다.
3. 유효한 후보만 사용해 release 상태, capability, fork, alias conflict, local trust를 판단한다.
4. 각 discovery의 `complete`, `provenance`, `warnings`를 최종 진단과 결과 상태에 보존한다.

Store의 순서나 provenance는 의미적 우선순위를 부여하지 않는다. partial completeness가 허용되지 않는 resolution 모드에서는 Resolution Layer가 실패 또는 불확정 결과를 선택해야 한다.

## 12. 정상·부정 시험 벡터

최소 시험 벡터:

- 동일한 ObjectId와 동일한 내용의 중복 삽입은 한 객체만 반환한다.
- 동일 ObjectId와 다른 내용의 삽입은 integrity 오류다.
- malformed 객체는 validator가 거부할 수 있도록 Store에서 조회 가능하다.
- 인덱싱 불가능한 malformed 객체는 `getObject`로 접근 가능하고 discovery 인덱스에는 잘못 포함되지 않는다.
- 삽입 순서가 달라도 모든 discovery 결과의 순서는 동일하다.
- binding discovery만 완전하고 release discovery가 불완전한 경우가 독립적으로 전달된다.
- provenance와 warnings가 부분 관측을 설명하며 객체의 신뢰성을 주장하지 않는다.
- `getObject`의 miss와 저장소 접근 실패가 구별된다.
- Resolution Layer가 Store 순서만으로 fork·conflict를 해소하지 않는다.

## 13. 동결 조건

다음이 충족되면 Store Interface v0를 동결한다.

- 모든 메서드의 입력, 반환 envelope, completeness 의미가 문서화되고 시험된다.
- ObjectId 중복·충돌·정렬·방어적 복사 규칙이 MemoryStore에서 재현된다.
- malformed-but-addressable 객체의 취급이 validator와 분리되어 있다.
- partial completeness와 provenance가 Resolution Layer 통합 시험에서 보존된다.
- Store가 의미 판단을 수행하지 않는 부정 시험이 통과한다.

## 14. v0 제외 범위

v0는 다음을 포함하지 않는다.

- 쓰기, 삭제, 동기화, 구독, 트랜잭션 API
- pagination, streaming, cursor의 표준화
- 네트워크 전송 프로토콜과 인증 방식
- provenance의 신뢰·서명 모델
- 캐시 무효화와 일관성 수준의 표준화
- federation, 복수 Store 병합 정책
- 의미적 ranking, trust policy, conflict resolution

## 구현 순서

1. Store result 타입
2. 인터페이스
3. MemoryStore
4. discovery adapter 연결
5. `resolveAlias` 통합 시험
6. partial completeness 시험
7. duplicate/provenance 시험
8. 동결

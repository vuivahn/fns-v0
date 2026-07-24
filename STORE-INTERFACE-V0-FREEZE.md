# Store Interface v0 Freeze

Store Interface v0의 후보 발견 계약과 참조 구현은 구현 검증을 거쳐 동결되었다. 이는 영구 불변 선언이 아니다. 이후 변경은 기존 적합성 벡터를 보존하는 호환 수정, 명세 오류 수정, 또는 v1/별도 adapter surface 도입 중 하나여야 한다.

## Frozen surface

- async read-only `FnsStore`의 네 메서드와 입력 계약
- `Candidate` (`{ objectId, object }`)와 discovery envelope 형식
- canonical base64url ObjectId 및 alias 입력의 경계 검증
- Candidate와 envelope의 strict JSON-value 경계
- `getObject`의 `Candidate | null` 의미와 접근 실패와의 분리
- 메서드·요청·provenance scope별 completeness 의미
- provenance의 비권위적 의미
- ObjectId 기반 중복 정규화와 상충 저장 표현의 `StoreIntegrityError`
- 후보·진단 배열의 locale-independent 코드포인트 정렬
- malformed-but-addressable 객체를 validator와 분리하는 규칙
- 반환값 방어적 복사와 호출 시점 snapshot 의미
- `InvalidRequestError`, `StoreAccessError`, `StoreIntegrityError` 범주
- MemoryStore의 read 행동 및 fixture 구성용 `put`, `setCompleteness`
- `discoverFromStore`와 `resolveAliasFromStore`의 async bridge 계약 및 Store 응답 검증
- 동결된 `fns-v0-validator` Core를 수정하지 않는 adapter 경계
- `test-vectors/store-interface-v0.json`과 `npm test` 적합성 시험

## Compatibility gate

Store Interface 변경은 다음을 훼손해서는 안 된다.

- AliasBinding v0, CommuneDocument v0, Resolution Layer v0의 JCS, ObjectId, signing input, signature 또는 검증 의미
- async adapter가 반환하는 내장 `resolution`의 동결된 `resolveAlias` 의미
- `complete: false`가 전역 부재 또는 객체 무효를 뜻하지 않는다는 의미
- Store 순서·provenance가 capability, fork, conflict, trust 우선순위를 결정하지 않는다는 경계

## Explicitly outside v0

- write/delete/sync/subscription/transaction API
- relay protocol, pagination, streaming, caching, federation
- provenance의 서명·신뢰·평판 모델
- multi-store merger, automatic head selection, ranking 및 trust policy
- 동결된 Core API의 async 전환 또는 의미 변경

## Conformance

```text
npm test
```

이 명령은 MemoryStore 중복·충돌·정렬·방어적 복사, malformed 후보, completeness/provenance/warnings, async Resolution adapter 및 부정 벡터를 검증한다.

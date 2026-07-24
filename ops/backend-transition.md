# Relay Backend 전환 기준

## 지원 토폴로지

Relay contract는 candidate metadata와 content blob을 분리해 다룬다. 특정 provider나
backend를 canonical/default로 지정하지 않는다.

| 운영 profile        | Candidate store    | Content blob store         | 위치                      |
| ------------------- | ------------------ | -------------------------- | ------------------------- |
| Local reference     | `SQLiteStore`      | filesystem `BlobStore`     | 로컬 또는 단일 운영 노드  |
| Optional serverless | `D1CandidateStore` | `R2ContentBlobStore`       | 선택적 serverless profile |
| Alternative adapter | PostgreSQL adapter | S3-compatible blob adapter | 요구사항에 따른 대체 구성 |

SQLite는 영구적인 reference backend다. schema, backend-neutral export/restore,
conformance fixture, migration 검증의 기준 구현으로 유지한다. PostgreSQL과
serverless profile은 규모·운영 제약에 맞는 대체 adapter이며 자동으로 더 우월하거나
기본값인 것으로 취급하지 않는다.

## 전환을 검토할 수 있는 조건

다음 중 하나가 관측되고, SQLite profile의 안전한 운영 조정만으로 해결되지 않을 때
대체 adapter를 검토한다.

- 실제 동시성·처리량·데이터 크기·복구 시간 요구가 단일 SQLite 운영 경계를 넘는다.
- 필요한 지리적 배치, 다중 운영자 접근, 관리형 내구성, 또는 네트워크 경계가
  SQLite 단일 노드 profile로 충족되지 않는다.
- provider 정책, 비용, 규제, 지원 모델이 serverless 또는 PostgreSQL adapter를
  요구한다.
- 정기 restore test, backup, integrity, 운영 인력 부담의 측정 결과가 현재
  profile의 primary RPO 1시간, provider-loss RPO 24시간, RTO 4시간을 지속해서
  충족하지 못함을 보여 준다.

이 목록은 전환을 자동 승인하는 trigger가 아니다. 결정 기록에는 측정치, 대안,
rollback 가능성, 비용·보안·운영 영향을 함께 남긴다.

## 전환 전 필수 게이트

1. 대상 candidate/blob adapter가 동일 Relay contract와 Store conformance
   fixture를 통과한다.
2. 객체·blob·completeness/provenance를 포함한 versioned backend-neutral export와
   import가 구현돼 있다.
3. source export와 destination import의 checksum, inventory, schema/export
   version을 비교하고 read query로 검증한다.
4. 새 backend에서 매시간 backup, 매일 off-provider copy, 정기 restore test가
   primary RPO 1시간, provider-loss RPO 24시간, RTO 4시간을 만족한다.
5. 접근 제어, TLS/secret 관리, token admission audit, 로그 redaction이 새
   adapter와 provider 경계에서 검증된다.
6. production 전 격리 restore와 rollback rehearsal를 수행한다.

## 전환과 rollback 절차

1. source에서 일관된 export/manifest를 생성하고 검증한다.
2. destination에 import한 뒤 inventory, integrity, conformance query, health를
   격리 환경에서 검증한다.
3. 짧은 read-only 또는 제한된 traffic 단계로 전환하고 관측성을 확인한다.
4. 검증 실패 시 source backend 또는 마지막 검증된 artifact로 rollback한다.
5. 전환 뒤에도 source export와 off-provider artifact를 정해진 retention 동안
   유지하고, 새 backend의 복구 test가 성공한 뒤에만 폐기 절차를 시작한다.

## 호환성 보존

- backend는 후보를 임의로 ranking하거나 canonical head를 선택하지 않는다.
- malformed-but-addressable object를 backend 특성 때문에 삭제·재검증하지 않는다.
- adapter별 최적화는 결과 ordering, completeness, provenance, 오류 의미를
  contract와 다르게 만들지 않아야 한다.
- serverless profile은 선택적 운영 profile이며 local SQLite reference와
  off-provider restore 가능성을 대체하지 않는다.

# 인프라 로드맵

이 문서는 FNS Store v0와 분리된 Relay v1 기반을 완성하기 위한 현재 상태와
다음 의사결정을 기록합니다. Relay는 선택적 discovery/publication 경로이며,
그 장애는 FNS 전체 장애가 아닙니다.

## 현재 상태

| 단계                      | 상태               | 완료된 기준                                                                                       | 남은 종료 조건                                                              |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1. 기준선·라이선스        | 완료               | Git 기준선, MPL/AGPL/CC0 경계, 전문과 패키지 메타데이터                                           | 릴리스 시 각 독립 배포물에 동일한 고지 포함                                 |
| 2. 품질 게이트            | 완료               | Node 20/22/24 CI, lint, format, strict test, coverage, audit, package dry-run                     | PR마다 계속 통과하고 취약점 경고를 정기 처리                                |
| 3. 어댑터 적합성          | 로컬 완료          | Relay contract/conformance, immutable conflict, blob conflict, bounded page 검증                  | D1/R2·PostgreSQL/S3 어댑터도 동일 runner 통과                               |
| 4. 영속 reference backend | 완료               | SQLite migration/WAL/integrity/physical backup/logical export, filesystem blob durability         | 실데이터 restore drill을 정기 실행                                          |
| 5. Relay v1               | 로컬 완료          | anonymous read, capability-gated publication, cursor, bounded SQL page, archive, health/readiness | cloud adapter, edge TLS/rate limit, 실제 공개 배포 검증                     |
| 6. 운영화                 | 문서·로컬 CLI 완료 | runbook, SLO/alert 기준, backend transition gate, archive admin CLI                               | scheduler/IaC/secrets/metrics/alerts/off-provider copy를 대상 플랫폼에 구현 |

## 확정된 원칙

- Core/Client/Standalone/Gateway/Builder와 Relay contract/adapters/conformance는
  MPL-2.0이다.
- 운영용 public Relay application과 운영 구현은 AGPL-3.0-or-later이다.
- specs/schemas/vectors는 CC0-1.0이다.
- Relay public read는 anonymous이고, publication admission은 Relay-local
  policy다. 초기 인증은 scoped, expiring opaque capability bearer token이다.
- FNS identity/trust/authority는 Relay 인증·정책과 완전히 분리한다.
- SQLite는 영구적인 reference backend이고, PostgreSQL은 scale 대안이다.
  serverless는 선택 profile이며 자동으로 우월하거나 기본값이 되지 않는다.
- 어떤 Relay도 canonical/default/trusted Relay가 아니다.
- backend-neutral export/restore와 off-provider restore 검증을 모든 profile의
  필수 조건으로 둔다.

## 복구 목표

| 범위                   | 목표            | 근거                                |
| ---------------------- | --------------- | ----------------------------------- |
| primary failure domain | RPO 최대 1시간  | hourly verified backup              |
| provider 전체 손실     | RPO 최대 24시간 | daily off-provider copy             |
| 복구                   | RTO 최대 4시간  | 격리 환경 restore test 및 실제 측정 |

daily off-provider copy를 유지하는 한 provider-loss RPO를 1시간이라고
주장하지 않는다. 그 목표가 필요하면 off-provider copy도 hourly로 올리는
별도 비용·보안·운영 결정을 해야 한다.

## 다음 실행 순서

1. 대상 운영 플랫폼을 정하고 IaC, TLS edge, rate limit, secret manager,
   observability, retention ownership을 명시한다.
2. local admin CLI를 scheduler에 연결해 hourly archive, daily independent copy,
   정기 restore drill을 실제로 수행하고 증적을 남긴다.
3. D1/R2 또는 PostgreSQL/S3 중 필요한 adapter를 하나 선택해 별도 패키지로
   구현한다. D1/R2는 Workers ESM 빌드로 격리한다.
4. 선택 adapter에 archive import/export, page-aware reads, conflict behavior,
   conformance, migration/rollback을 구현한다.
5. 격리 환경에서 provider-loss restore와 RTO를 측정한 뒤, SLO/alert 수치를
   실제 traffic 기준으로 확정한다.
6. 마지막으로 abuse/privacy policy와 capability 발급·회수 절차를 검토하고,
   공개 traffic을 단계적으로 연결한다.

세부 운영 절차는 [ops/README.md](ops/README.md), protocol 경계는
[RELAY-V1-RFC.md](RELAY-V1-RFC.md)에 있다.

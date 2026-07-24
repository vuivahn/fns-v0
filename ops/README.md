# Relay 운영 프로파일

이 디렉터리는 AGPL-3.0-or-later public Relay application의 운영 기준을
기록한다. FNS Store v0 계약이나 FNS identity/trust/authority 모델을 바꾸지
않는다.

## 원칙

- 어느 Relay도 canonical, default, trusted Relay가 아니다.
- anonymous public read와 Relay-local publication admission을 분리한다.
- capability bearer token, authorization header, pepper, private object 내용은
  로그·trace·metric label·archive에 기록하지 않는다.
- SQLite는 영구 reference backend이고 PostgreSQL·serverless는 선택 대안이다.
- 모든 backend는 logical export/restore와 conformance를 제공해야 한다.
- Relay 장애는 FNS 전체 장애가 아니다. 영향 endpoint와 대체 discovery 경로를
  구분해 알린다.

## 복구 목표

| 목표                       | 기준                                      |
| -------------------------- | ----------------------------------------- |
| primary failure-domain RPO | 1시간 이하                                |
| provider-loss RPO          | 24시간 이하 (daily independent copy)      |
| RTO                        | 4시간 이하                                |
| backup                     | 매시간 검증된 logical archive             |
| off-provider copy          | 매일 독립 provider/계정/권한 경계에 복사  |
| restore test               | 정기 및 storage/schema/deployment 변경 후 |

primary RPO와 provider-loss RPO를 혼동하지 않는다. provider 전체 손실에도
1시간 RPO가 필요하면 off-provider copy를 hourly로 변경하는 별도 승인이
필요하다.

## 운영 문서

- [Relay runbook](relay-runbook.md): archive, copy, restore, incident 절차
- [SLO와 alert 기준](slo-alerts.md): 측정·경보 최소 기준
- [Backend 전환 기준](backend-transition.md): SQLite 유지·대체 adapter 선택 gate

로컬 기준 application의 실행과 archive CLI는
[public Relay application guide](../relay-v1/apps/public-relay/README.md)에 있다.

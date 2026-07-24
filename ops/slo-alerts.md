# Relay SLO·알림 체크리스트

## 공개 전 SLO 기준

이 운영 프로필은 recovery objective를 확정한다.

| 목표                       | 기준                                     | 측정 증거                                                                        |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| Primary failure-domain RPO | 최대 1시간                               | 마지막 checksum 검증 hourly backup의 생성 시각                                   |
| Provider-loss RPO          | 최대 24시간                              | 마지막 검증된 daily off-provider copy의 생성 시각                                |
| RTO                        | 최대 4시간                               | incident 시작부터 검증된 read service 복귀 또는 안전한 제한 상태 전환까지의 시간 |
| 매시간 backup              | 모든 계획된 실행이 검증된 export를 남김  | backup job 결과와 manifest 검증 기록                                             |
| 매일 off-provider copy     | 매일 최소 하나의 독립 위치 복사본을 검증 | destination-side checksum과 접근 검증 기록                                       |
| restore readiness          | 정기 및 변경 후 restore test 성공        | 격리 환경 restore test 기록                                                      |

공개 API의 availability, latency, error-budget 목표값은 실제 traffic, data
classification, 운영 인력, provider 계약을 검토한 뒤 별도 SLO 문서에서 정한다.
이 문서는 근거 없는 수치를 미리 약속하지 않는다.

## 필수 계측

- public read endpoint별 요청 수, 성공률, p50/p95/p99 latency, 4xx/5xx 비율
- admission 요청 수, allow/deny/error 비율, rate-limit 및 quota 적용 수
- candidate/blob store의 연결 오류, timeout, integrity 오류, 용량/할당량 여유
- backup 시작·종료·검증 결과, 최신 검증 backup의 age, off-provider copy 결과
- restore test 성공·실패·소요 시간, export/import format 또는 schema version
- health와 readiness 상태, 배포 버전, migration 결과

로그·trace·metric label에는 bearer token, authorization header, private object
content, encryption key, 전체 object ID 목록을 넣지 않는다.

## 알림 우선순위

### 즉시 대응 (page)

- public read가 광범위하게 실패하거나 health/readiness가 지속적으로 실패한다.
- data corruption, checksum 불일치, integrity check 실패가 감지된다.
- backup 작업이 실패했거나 마지막 검증 hourly backup이 primary RPO 1시간을 초과한다.
- off-provider copy 검증이 실패하거나 가장 최근 일일 복사본을 읽을 수 없다.
- restore test가 실패하거나 RTO 4시간 내 복구 가능성을 입증하지 못한다.
- capability token 오남용, credential 유출 의심, admission 우회가 탐지된다.

### 신속 조사 (ticket 또는 on-call 판단)

- error rate·latency·storage timeout이 기존 기준선을 지속적으로 벗어난다.
- storage 용량, provider quota, backup retention, encryption key 접근에 여유가
  부족하다.
- admission deny, rate-limit, auth adapter 오류가 비정상적으로 증가한다.
- backup/export format, schema migration, deployment가 복구 test 없이 변경됐다.

## 각 알림의 최소 응답 정보

각 alert에는 다음을 포함한다.

1. 영향받는 Relay/region/backend와 시작 시각
2. 최신 정상 health, backup, off-provider copy, restore test 시각
3. 관련 deployment, migration, storage/auth adapter 변경
4. Runbook의 해당 절차와 escalation 담당자
5. secret을 노출하지 않는 조사용 correlation ID

알림 메시지는 Relay 장애가 곧 FNS 전체 장애라는 인상을 주지 않도록 endpoint와
backend 수준의 영향을 기술한다.

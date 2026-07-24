# Infrastructure Roadmap

이 문서는 Store Interface v0를 안전하게 완성하고 Relay/운영화로 확장하기 위한 현재 상태와 다음 의사결정을 기록합니다.

| 단계             | 상태      | 완료한 내용                                                                                        | 다음 완료 기준                                                |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1. 기준선 보존   | 완료      | Git 원격 연결, 초기 소스·테스트 추적, 줄바꿈·ignore 정책, README                                   | 라이선스 선택 후 공개/배포 정책 확정                          |
| 2. 품질 게이트   | 완료      | ESLint, Prettier, c8 coverage, production audit, package dry-run, Node 20/22/24 CI, Dependabot     | PR에서 CI가 계속 통과하고 의존성 경고를 정기 처리             |
| 3. 어댑터 적합성 | 완료      | MemoryStore와 SQLiteStore가 공유 read conformance fixture를 통과                                   | 후속 DirectoryStore/외부 Store도 같은 runner에 연결           |
| 4. 영속 Store    | 완료      | SQLite schema v1, 파생 인덱스, scoped completeness, migration, WAL, backup/restore, integrity 검증 | 실제 운영 데이터의 import/backup 주기와 복구 훈련 합의        |
| 5. Relay         | 준비됨    | v0 밖으로 분리한 Relay RFC와 안전 제어 목록                                                        | 승인된 Relay v1 wire spec과 접근 정책으로 별도 서비스 구현    |
| 6. 운영화        | 부분 준비 | CI 컨테이너, dependency update, 운영·복구 문서                                                     | 클라우드/IaC, TLS, secrets, 관측성, SLO, 알림, 복구 훈련 구현 |

## 다음으로 결정할 항목

실제 Relay나 공개 운영은 다음 선택 없이는 안전하게 가정할 수 없습니다.

1. 라이선스와 공개 범위: private 유지, 소스 공개, npm 배포 여부와 소유자/기여 정책
2. Relay 접근 정책: 공개 read-only, API token, OIDC, mTLS 중 선택 및 tenant 모델
3. 배포 환경: 클라우드 계정·리전·도메인·TLS 종료 지점·예산·가용성 목표
4. 데이터 운영: 단일 노드 SQLite 지속 여부, RPO/RTO, backup 보존·암호화, 운영자 접근 통제
5. Relay wire contract: URL/media type, pagination/cursor, response·timeout 한도, structured error, cache semantics
6. 관측성과 대응: 로그 redaction, metrics/traces, health/readiness, SLO, 알림, 장애·복구 runbook

## 권장 실행 순서

1. 라이선스와 Relay 접근 정책을 결정한다.
2. SQLite snapshot을 실제 데이터로 반복 import하고 backup/restore drill을 수행한다.
3. 위 결정을 ADR/threat model로 승인한다.
4. 별도 `relay-v1` 패키지에서 read-only wire contract와 conformance 테스트를 구현한다.
5. 사설 환경에서 TLS, secrets manager, 관측성, 부하·보안·복구 검증을 통과시킨다.
6. SLO와 운영 승인 뒤에만 공개 배포한다.

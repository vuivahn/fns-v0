# Relay 백업·복구 Runbook

이 runbook은 local reference profile의 실제 archive CLI와, 다른 adapter가
동일한 logical archive contract를 구현할 때 지켜야 할 운영 절차를 정의한다.

## 사전 조건

- candidate DB, capability DB, blob directory, two secret values를 배포 secret
  manager에서 주입한다.
- capability DB와 candidate DB는 서로 다른 파일이다.
- backup operator, restore operator, off-provider copy operator의 권한을
  분리한다.
- archive에는 capability token, pepper, signing key, operator account, audit
  log가 들어가지 않는지 버전별로 확인한다.

아래 명령은 local profile 환경 변수가 이미 설정되어 있다고 가정한다.

## 매시간: logical archive와 검증

1. 운영 scheduler가 고유한 새 파일 경로를 만들고 export를 실행한다.
   \`export\`는 기존 파일을 덮어쓰지 않는다.

   \`\`\`powershell
   npm.cmd --prefix relay-v1/apps/public-relay run admin -- export C:\relay-backups\relay-2026-07-24T010000Z.json
   \`\`\`

2. 종료 코드, archive digest, destination file mode, 생성 시각을 기록한다.
3. 같은 profile에서 전체 integrity 확인을 실행한다.

   \`\`\`powershell
   npm.cmd --prefix relay-v1/apps/public-relay run admin -- verify
   \`\`\`

4. 실패하거나 마지막 검증 archive가 한 시간을 넘으면 primary RPO 위반
   incident로 처리한다. 다음 주기를 기다리지 않는다.

\`/readyz\`는 full archive 검증이 아니다. public endpoint에 O(N) I/O를
노출하지 않기 위해 가벼운 저장소 reachability만 확인한다.

## 매일: off-provider copy

1. 가장 최근의 검증된 archive와 별도 manifest/checksum을 독립 provider,
   계정, 권한 경계, 가능하면 독립 failure domain으로 복사한다.
2. 대상에서 digest/checksum과 archive parse를 다시 확인한다.
3. source와 destination의 retention, 암호화 키, 접근 제어를 따로 기록한다.
4. copy 또는 verification 실패는 provider-loss RPO 24시간 위반 위험으로
   처리한다.

단순히 다른 버킷이나 다른 path만 쓰는 것은 off-provider copy가 아니다.
독립성의 근거(provider, account, credential, region/failure domain)를 운영
기록에 남긴다.

## 정기 restore drill

매 배포·schema migration·storage/auth adapter 변경 뒤와 정기 주기에 다음을
격리 환경에서 수행한다.

1. production credential을 주입하지 않은 별도 candidate DB, capability DB,
   blob directory를 만든다.
2. archive를 validation-only로 읽는다.

   \`\`\`powershell
   npm.cmd --prefix relay-v1/apps/public-relay run admin -- restore-validate C:\relay-backups\relay.json
   \`\`\`

3. 그 격리 대상에만 명시적으로 replacement restore를 수행한다.

   \`\`\`powershell
   npm.cmd --prefix relay-v1/apps/public-relay run admin -- restore-replace C:\relay-backups\relay.json --confirm-replace
   \`\`\`

4. \`admin -- verify\`, object/blob inventory, representative public read query,
   candidate/blob conformance, archive digest를 검증한다.
5. 시작부터 검증된 read service까지의 시간을 기록한다. 4시간을 넘기면 RTO
   미달 incident다.
6. 사용 archive, digest, elapsed time, 실패/불일치, corrective action을
   보존한다.

## 장애 대응

1. health/readiness, storage integrity, archive, off-provider copy, restore
   test 중 어느 경보인지 먼저 분류한다.
2. candidate/blob corruption이 의심되면 publication을 먼저 막고 영향을 받은
   endpoint를 제한한다.
3. primary failure면 마지막 hourly archive를, provider-loss면 마지막
   off-provider archive를 선택한다. 각각 RPO 1시간/24시간 범위임을
   incident에 명시한다.
4. production storage에 직접 덮어쓰기 전에 격리 restore/verify를 우선한다.
5. 성공 후 traffic을 단계적으로 복구한다. 실패하면 마지막 정상 archive나
   대체 adapter로 rollback한다.
6. Relay outage를 FNS 전체 outage로 선언하지 않는다. 영향 범위를 endpoint,
   backend, region/profile 단위로 표현한다.

## 변경 gate

archive format, storage adapter, migration, deployment, token handling,
retention, encryption, or scheduler를 바꾸면 다음 restore drill이 성공하기
전까지 변경을 완료로 선언하지 않는다.

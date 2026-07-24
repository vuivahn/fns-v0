# FNS Store Interface v0

FNS Core v0와 저장·전송 환경 사이의 비동기, 읽기 전용 후보 발견 경계에 대한 참조 구현입니다. Store는 검증되지 않은 JSON 후보와 관측 정보를 제공할 뿐, 객체 유효성, release 상태, capability, fork, conflict, local trust를 판단하지 않습니다.

현재 이 저장소는 서비스나 Relay가 아니라 `MemoryStore`와 async adapter를 제공하는 Node.js 라이브러리입니다.

## 상태와 범위

- Node.js 20 이상 지원
- `FnsStore`의 네 read API와 `MemoryStore` 참조 구현 제공
- `discoverFromStore`와 `resolveAliasFromStore` async bridge 제공
- canonical ObjectId, strict JSON 값, 결정적 코드포인트 정렬, defensive copy를 검증
- write/delete/sync/subscription/transaction, relay, pagination, federation, ranking, trust policy는 v0 범위 밖

상세 계약은 [Store Interface v0 Plan](STORE-INTERFACE-V0-PLAN.md)과 [Store Interface v0 Freeze](STORE-INTERFACE-V0-FREEZE.md)를 참고하세요.

## 시작하기

```text
npm ci
npm test
```

PowerShell 실행 정책으로 `npm` shim이 막힌 환경에서는 다음 명령을 사용합니다.

```text
npm.cmd test
```

## API

```js
const {
  FnsStore,
  MemoryStore,
  discoverFromStore,
  resolveAliasFromStore
} = require("fns-store-interface-v0");

const store = new MemoryStore({ source: "memory:example" });
// store.put(...) is fixture/reference-store setup only.

const discovery = await discoverFromStore({ context, alias }, store);
const result = await resolveAliasFromStore({ context, alias }, store);
```

`FnsStore` 구현은 `getObject`, `findAliasBindings`, `findAliasReleases`, `findCommuneDocuments`를 비동기로 제공해야 합니다. 발견 결과는 `complete`, `provenance`, `warnings`를 메서드별로 보존합니다.

## 개발 및 검증

```text
npm run check
npm test
npm run test:strict
```

GitHub Actions는 Node.js 20, 22, 24에서 위 검증과 package dry-run을 실행합니다.

## 라이선스

이 저장소의 라이선스는 아직 선택되지 않았습니다. 공개 재배포 또는 npm 배포 전에 저장소 소유자가 명시적인 라이선스를 추가해야 합니다.

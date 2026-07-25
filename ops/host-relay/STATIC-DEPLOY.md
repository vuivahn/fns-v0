<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 정적 FNS 콘텐츠 배포 (alice 페이지 + 디스크립터 사이드카)

MVP 단계에서 relay-v1 코드 변경 없이, funnel-edge(재고 nginx)가 alice 정적
페이지와 서비스 디스크립터 사이드카를 직접 서빙하도록 한다. 릴레이 이미지
리빌드/재배포는 필요 없다 — 엣지 컨테이너 재생성만으로 반영된다.

> 전제: admin SSH 접근이 재발급되어 있어야 한다 (이전에 전용 키를 삭제했다).

## 변경 내용 (이미 로컬 저장소에 반영됨)

- `ops/host-relay/nginx/funnel.conf.template` — `location /alice/` 와
  `location /fns-descriptors/` 추가 (정적 서빙, relay로 프록시하지 않음).
- `ops/host-relay/compose.funnel.yaml` — `funnel-edge` 에 정적 콘텐츠 디렉터리를
  읽기전용 바인드 마운트(`-> /srv/fns-static`) 추가. 소스는
  `${FNS_RELAY_STATIC_DIR:-/opt/fns-relay/static}`.
- `ops/host-relay/static/alice/index.html` — alice 정적 페이지 원본.
- `fns-profile/fns-descriptors/alice.json` — 빌드된 alice 디스크립터 envelope.

## 홈서버 적용 절차

1. **정적 디렉터리 생성** (엣지가 uid/gid 101:101 으로 읽어야 한다; 디렉터리가
   없으면 엣지가 시작하지 못해 공개 Funnel이 다운된다 — 디렉터리를 먼저 만들 것).

   ```sh
   sudo mkdir -p /opt/fns-relay/static/alice /opt/fns-relay/static/fns-descriptors
   sudo chown -R 101:101 /opt/fns-relay/static
   sudo chmod -R u+rwX,go+rX /opt/fns-relay/static
   ```

2. **콘텐츠 배치**:
   - alice 페이지: 저장소의 `ops/host-relay/static/alice/index.html` 을
     `/opt/fns-relay/static/alice/index.html` 로 복사.
   - 디스크립터 사이드카: 로컬에서 빌드한 `fns-profile/fns-descriptors/alice.json` 을
     서버의 `/opt/fns-relay/static/fns-descriptors/<subject-keyId>.json` 으로 복사.
     파일명에 콜론이 포함된다 (Linux는 허용). keyId는 빌더 출력에 인쇄됨, 예:
     `fns:key:ed25519:ZHVlzJTnvNC8l-Qzx8Sr4oh5CLZ7K3xAYCbkpJhJkEE.json`
   - 배치 후 소유자/권한 재적용:
     `sudo chown -R 101:101 /opt/fns-relay/static && sudo chmod -R u+rwX,go+rX /opt/fns-relay/static`

3. **ops 체크아웃 갱신**: 서버의 ops 체크아웃 디렉터리에서 변경된
   `nginx/funnel.conf.template` 과 `compose.funnel.yaml` 을 반영한다
   (커밋/풀 하거나 SSH로 직접 편집).

4. (선택) `relay.env` 에 `FNS_RELAY_STATIC_DIR=/opt/fns-relay/static` 명시.
   기본값이 같으므로 생략 가능.

5. **엣지 재생성** (릴레이 컨테이너는 그대로):

   ```sh
   cd <ops/host-relay 체크아웃>
   docker compose --project-name fns-relay-funnel \
     --env-file /etc/fns-relay/relay.env \
     -f compose.funnel.yaml up -d funnel-edge
   ```

6. **확인**:

   ```sh
   curl -sS https://hellel.tailc61a4a.ts.net:8443/alice/ | head
   curl -sS "https://hellel.tailc61a4a.ts.net:8443/fns-descriptors/fns%3Akey%3Aed25519%3A<...>.json" | head
   ```

   둘 다 200 이어야 한다. 기존 릴레이 엔드포인트(`/v1/objects/...`,
   `/v1/discovery/...`)도 정상 동작을 확인한다.

## 주의

- 엣지는 공개 Funnel의 TLS 종단이므로, 엣지가 뜨지 않으면 릴레이 전체가 공개적으로
  unreachable 이 된다. 1단계(디렉터리 생성)를 반드시 먼저 수행할 것.
- 디스크립터의 endpoint는 `https://hellel.tailc61a4a.ts.net:8443/alice/` 이다.
  alice 페이지는 X-Frame-Options/CSP frame-ancestors 를 설정하지 않으므로 확장의
  iframe 으로 로드된다.
- MVP에서는 디스크립터를 릴레이 스토어에 게시하지 않는다 (사이드카로 서빙).
  Phase 2에서 `GET /v1/discovery/service-descriptors` 엔드포인트가 추가되면
  사이드카는 제거된다.

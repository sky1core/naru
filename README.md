# Naru

Electron 내장 Chromium을 로컬 HTTP API와 CLI로 제어한다. 창에서 직접 로그인하고, 같은 앱의 전용 프로필을 계속 사용한다. 별도 브라우저·확장 기능·외부 디버깅 포트가 필요하지 않다.

## 실행

Node.js 22.12 이상과 GUI 데스크톱이 필요하다. 현재 검증 환경은 macOS arm64다.

```sh
npm ci
npm start
```

프로젝트를 고정하면 해당 프로젝트에서 시작하며, 최초 시작 페이지는 `https://chatgpt.com/`다. 프로필은 `$HOME/.chatgpt-relay`다. 서비스 계정에 처음 로그인하는 절차는 열린 창에서 직접 진행한다. 앱을 종료해도 프로필·요청 기록은 유지한다. `https://chatgpt.com`의 `persistent-storage` 권한은 전용 프로필 저장 용도로 허용하며 재시작마다 묻지 않는다. 나머지 권한의 허용·거부는 해당 실행 동안만 유지한다. 마이크·카메라와 파일 대상·읽기·쓰기는 각각 구분해 승인한다.

```sh
npm start -- --profile ./artifacts/dev-profile --url https://example.com/
```

같은 프로필의 앱은 하나만 실행한다. 개발·검증에는 별도 `--profile`을 지정한다. 프로필은 로그인 상태와 읽은 결과를 포함하므로 공유하거나 커밋하지 않는다.

## CLI

다른 터미널에서 실행한다. 앱에 `--profile`을 지정했으면 CLI에도 같은 경로를 지정한다.

```sh
npm run naru -- status
npm run naru -- snapshot
npm run naru -- diagnostics
npm run naru -- navigate https://chatgpt.com/
npm run naru -- --help
```

`snapshot`의 `documentId`와 실제 관찰한 속성을 사용한다. 아래 식별자는 예시다.

```sh
npm run naru -- fill --document <documentId> --attr id --value <composer-id> --file prompt.txt
npm run naru -- click --document <documentId> --attr data-testid --value <send-button-id>
npm run naru -- read --document <documentId> --attr data-message-id --value <response-id>
npm run naru -- screenshot --out page.png
npm run naru -- quit
```

`press Enter`는 명시한 요소에 키를 보낸다. `wait`는 요소의 등장·제거만 기다리며, AI 답변 완료를 추측하지 않는다. `click`·`press`의 `dispatched`는 입력 전달을 뜻하며 외부 서비스 처리 완료 보장이 아니다.

대상 속성은 `--help`와 `src/protocol.mjs`의 허용 목록을 따른다. JSON target의 `scope: {attribute, value}`로 명시한 부모 안에 한정할 수 있으며 부모와 대상은 각각 유일해야 한다. `snapshot`은 속성·구조·가시성과 `parentIndex`를 반환한다. 화면 문구, 번역된 접근성 이름, CSS 순번, 임의 JavaScript 실행은 입력 계약에 없다. 화면 변경으로 문서 ID가 낡았으면 `stale_document`를 반환한다.

## 파일 리뷰

먼저 브라우저에서 사용할 프로젝트의 첫 화면을 열고 한 번 고정한다. 고정한 ID와 주소는 전용 프로필에 저장한다.

```sh
npm run naru -- project-bind
npm run naru -- project
npm run naru -- project-open
```

`--continue-from`이 없는 새 리뷰는 저장한 프로젝트 첫 화면을 새 문서로 열고 새 대화에서 시작한다. 이전 화면에 초안·첨부·진행 중 응답이 있으면 보존하고 오류를 반환한다. 전송 버튼은 실행 기한 안에서 활성화될 때까지 기다린다. 입력 전·전송 전·실제 이벤트 전달 때 프로젝트와 문서를 확인한다.

`prepare`는 앱 실행이나 로그인 없이 원문을 준비한다. UTF-8 파일의 BOM·개행·공백을 보존하고 파일별 SHA-256을 기록한다. 기준 디렉터리 밖의 파일, 밖으로 향하는 링크, 중복 파일, 특수 파일, 읽는 중 바뀐 파일은 거절한다. API 입력 한도 8 MiB를 넘으면 원문을 줄이지 않고 오류를 반환한다.

```sh
npm run naru -- prepare --question '오류와 수정 근거를 검토해줘' --effort max --file src/example.mjs --out review-input.json
npm run naru -- doctor
npm run naru -- ask --request review-input.json --out review-answer.txt
npm run naru -- collect --out review-answer.txt
```

`ask --question ... --file ... --file ... --out ...`으로 바로 요청할 수도 있다. `--base-dir` 기본값은 현재 디렉터리이며 파일 경로는 이를 기준으로 해석한다. `--timeout`은 답변 회수의 전체 대기 시간(ms)이며 기본 1,800,000이다. 요청은 **고정한 프로젝트**에 보내며, `ask`와 `prepare`의 `--effort none|medium|high|max|pro`로 추론 수준을 지정한다. 생략하면 해당 composer의 기존 선택을 유지한다. 안정적 DOM 속성으로 선택값과 Pro 여부를 확인하고, 전송 중 선택이 바뀌면 중단한다. 선택할 수 없는 effort를 다른 값으로 대체하지 않는다.

자료를 나누어 보낼 때는 `--part N/TOTAL`을 사용한다. 첫 조각은 새 대화에서 시작하고, 다음 조각은 직전 출력의 `--continue-from`으로 이어 보낸다. 조각 순서와 총수는 고정하며 마지막 조각에서 전체를 리뷰한다. 중간 응답은 수신 확인이며 최종 리뷰가 아니다.

```sh
npm run naru -- ask --part 1/2 --effort max --question '자료 1/2 수신 확인' --file first.patch --out part1.txt
npm run naru -- ask --part 2/2 --continue-from part1.txt --effort max --question '모든 자료를 함께 리뷰해줘' --file second.patch --out review.txt
npm run naru -- ask --continue-from review.txt --effort high --question '첫 번째 지적의 수정안을 설명해줘' --out follow-up.txt
```

`--continue-from`은 같은 프로필의 이전 출력과 `<출력>.request.json`을 사용한다. 이전 입력·답변 해시와 메시지 ID, 대화 이력을 확인한다. 다른 대화가 열렸으면 현재 초안·첨부·생성이 없을 때 저장된 이전 대화를 연다. 중간에 다른 질문이 있거나 기존 내용이 바뀌면 전송하지 않는다. 이전 요청에 이미 후속 전송 시도가 기록되어 있으면 다른 후속 요청을 만들지 않는다. 전송 직전과 실제 입력 이벤트에서도 이력을 확인한다.

분할 입력은 직전 수신 확인을 `collect`한 뒤에만 다음 조각을 보낸다. 생성이 멈췄는데 수신 확인 표식이 빠졌으면 같은 `--part N/TOTAL`과 그 체크포인트의 `--continue-from`으로 수신 확인만 요청한다. 복구 요청에는 `--file`을 넣지 않으며 기존 원문을 그대로 사용한다. 복구한 수신 확인을 회수한 뒤 다음 조각은 그 복구 출력에 연결한다. 일반 이어 보내기는 이전 출력이 아직 없더라도 체크포인트가 있고 원래 요청을 관찰할 수 있으며 생성이 멈춘 경우 가능하다. 이때도 이전 자료를 재전송하지 않는다. `prepare`에도 `--part`·`--continue-from`을 사용할 수 있고, 연결 정보는 준비한 JSON과 체크포인트에 포함된다. `--request`에는 새 입력 옵션을 함께 넘기지 않는다.

출력 옆 `<출력>.request.json`에 리뷰 ID·원문·effort·입력 해시·준비 요청 ID·프로필 연결을 전송 전에 저장한다. 출력과 체크포인트를 덮어쓰지 않는다. 전송 시도 기록이 없는 `prepared`·`preparing`·`failed` 요청은 원인을 해결하고 `submit --out <같은 출력>`으로 명시적으로 재개한다. 초안은 비어 있거나 원래 요청과 정확히 같아야 하며, 기존 초안을 이어 쓸 때는 저장된 대화와 이력도 일치해야 한다. 서버가 `busy` 등으로 준비를 거절했으면 같은 명령이 체크포인트의 원문으로 준비부터 재개한다. 전송 뒤 실제 메시지 ID와 대화 URL을 저장한 후 `submitted`를 반환한다. 이 확인이 끝나기 전에 기한이 지나면 `uncertain`으로 남으며 기존 요청을 회수한다. 실제 전송 이벤트를 시도한 요청은 `submit`을 반복해도 재전송하지 않는다. `collect`는 입력 해시와 effort가 일치하는 기존 요청만 회수한다. 재시작 등으로 다른 화면이 열렸으면 현재 초안·첨부·생성이 없을 때 기록된 대화를 열고 원래 메시지를 검증한다.

`review-status <UUID>`의 `phase`와 `lastFailure`로 페이지 확인·열기, effort 선택·입력·전송 중 멈춘 단계와 오류를 확인한다. 실행 기한이 지나면 전송 시도 전에는 `failed`, 이후에는 `uncertain`을 기록한다. 이전 브라우저 작업이 아직 종료되지 않았으면 새 명령은 계속 차단되며, `status.execution`이 비어 있을 때 재개할 수 있다. 앱을 종료했다가 다시 열어도 같은 프로필과 체크포인트를 사용하며, 기록된 프로젝트 바인딩이 바뀌었으면 재개하지 않는다. `--deadline`은 준비·전송·각 회수 명령의 실행 기한이며, 오류 원인 확인 없이 기한만 늘려 새 요청을 만들지 않는다.

리뷰 본문·상태·결과는 전용 프로필에 보존한다. 요청 UUID와 메시지 ID로 전송한 메시지를 식별하고 원문 검증은 별도로 수행한다. 링크 위젯의 복사 제외 장식을 제거하고 실제 inline code 범위를 원문의 전체 백틱 구분자·내용과 대조한다. 화면 표기에서 추가된 [CommonMark ASCII 구두점 escape](https://spec.commonmark.org/0.31.2/#backslash-escapes)와 원문에 있는 문자열의 자동 링크 표시만 허용한다. 원문 문자 삭제·치환이나 표시 문자열과 목적지가 다른 링크는 `review_content_mismatch`로 중단한다. 답변은 해당 요청의 메시지 식별자, 응답 완료 버튼 또는 해당 응답의 작업 영역, 생성 중 표시 해제, 요청별 끝 표식과 안정된 본문을 함께 확인한 뒤 신규 파일로 원자적으로 저장한다. 부분 응답·다른 요청의 답변·중복 응답은 완료 결과로 저장하지 않는다. 긴 대화에서 화면 밖으로 빠진 이전 메시지는 대화 이력을 스크롤해 다시 읽고, 메시지 ID·순서·본문을 저장 기록과 대조한다. 이전 원문을 다시 보내지 않는다. 입력·답변·체크포인트에는 비공개 자료가 포함될 수 있으므로 공개 저장소 밖에 둔다.

## API

실행 중 `<profile>/connection.json`에 임의 loopback 포트와 실행별 토큰을 저장한다. 파일은 소유자만 읽도록 생성한다. CLI는 토큰과 본문을 보내기 전에 nonce/HMAC으로 서버를 인증하고, 인증한 TCP 연결에서만 요청한다. 연결을 잃으면 재전송하지 않는다. 서버 신원 확인을 제외한 모든 요청에 `Authorization: Bearer <token>`이 필요하며, 브라우저 Origin 요청은 거절한다.

| 요청 | 동작 |
|---|---|
| `GET /v1/identity` | `X-Naru-Nonce`의 64자리 소문자 hex nonce와 연결 포트에 대한 서버 신원 증명 |
| `GET /v1/status` | URL·문서 ID·로딩·renderer 상태 |
| `GET /v1/snapshot` | 문서 ID와 DOM의 대상 속성 목록 |
| `GET /v1/diagnostics` | 네트워크 실패 총수·최근 100건, 마지막 입력의 처리 단계·브라우저 수신 확인·이벤트 종류(본문·인증값 제외) |
| `GET /v1/project` | 고정한 프로젝트 ID·주소(미설정이면 null) |
| `GET /v1/review-ui` | 리뷰용 DOM 관찰 및 로그인·식별자 문제 |
| `GET /v1/reviews/<UUID>` | 해당 리뷰의 입력·상태·완료 결과 |
| `POST /v1/commands` | `{ "id": "<UUID>", "command": { ... } }` 실행 |
| `GET /v1/requests/<UUID>` | 원래 요청의 결과 조회 |

POST는 `Content-Type: application/json`, 본문 최대 8 MiB다. 초과하면 실행하지 않고 오류를 반환한다. 요청 스키마는 `src/protocol.mjs`에서 엄격히 검증한다.

회수 요청 저널에는 원문 사본 대신 리뷰 ID·원문 해시와 해당 시점의 결과를 저장한다. 요청 재조회 시 검증한 정본 원문을 함께 반환하며, 기존 저널 형식도 읽을 수 있다.

`deadlineMs`는 main 프로세스의 실행 기한이다. `review.*` API와 CLI의 `ask`·`submit`·`collect`는 기본 120,000ms, 일반 명령은 기본 30,000ms이며 최대값은 120,000ms다. CLI에서는 `--deadline`으로 명시한 값을 그대로 적용한다. `wait`의 조건 대기 시간을 늘릴 때는 실행 기한도 명시한다.

```json
{
  "id": "2b40c960-2523-43a1-8f8a-ad87a6ee42f3",
  "command": {
    "action": "fill",
    "documentId": "1c9a29d6-ef3a-4843-bb0a-d4ffad45670c",
    "target": { "attribute": "id", "value": "composer" },
    "text": "전달할 본문"
  }
}
```

이 형식을 파일에 저장하면 `npm run naru -- run --file request.json`으로 같은 API를 호출한다. `navigate`, `fill`, `click`, `press`, `read`, `wait`, `screenshot`, `quit`을 지원한다.

`project.bind`는 현재 프로젝트 첫 화면의 `documentId`를 받는다. `project.open`은 저장한 프로젝트를 연다. 리뷰 명령도 같은 POST 계약을 사용한다. `review.prepare`는 `reviewId`, `question`, `files: [{path, content, sha256, bytes}]`, 선택 사항인 `effort`, `part: {index, total}`, `continueFrom: {reviewId, promptHash, answerHash?, effort?}`를, `review.submit`은 `reviewId`, `documentId`, `review.collect`는 `reviewId`, `waitMs`를 받는다. `continueFrom`의 해시와 effort는 직전 기록의 값이며, 완료된 답변에는 `answerHash`가 필수다. `prepare` CLI가 첫 명령의 JSON을 만든다. `waitMs` 최대값은 119,000이며 실행 기한은 대기 시간보다 길게 지정한다. `review.collect`가 `completed`를 반환하기 전에는 답변이 확정되지 않았다.

## 실패와 재호출

명령은 실행 전에 요청 ID를 기록한다. CLI는 생성한 ID를 stderr에 먼저 출력하며 `--id`로 직접 지정할 수도 있다.

- 같은 ID·같은 명령·같은 실행 기한: 기록된 결과를 반환하며 재실행하지 않는다.
- 같은 ID·다른 명령: `request_conflict`.
- 실행 중 또는 중단으로 최종 기록 없음: `outcome_unknown`. 새 ID로 자동 재전송하지 않는다.
- 동시 실행: `busy`; 새 명령은 시작하지 않는다.
- 실행 기한 초과: `command_timeout`, 기록은 `uncertain`. 이미 전달한 입력의 결과를 추측하지 않으며 추가 입력을 보내지 않는다. 이전 작업이 아직 끝나지 않았으면 `browser_unresponsive`로 새 명령을 막는다. `status`·`diagnostics`·`quit`은 계속 사용할 수 있다.
- 텍스트 입력은 대상 확인·선택·브라우저 편집 명령을 같은 renderer 실행에서 처리한다. 키·포인터 입력은 격리된 preload와 프레임 검사로 잘못된 대상의 이벤트를 차단한다. 차단 시 `target_changed`를 반환한다.
- 키·포인터 명령은 앱 내부의 Chromium 프로토콜로 전달하고, 입력 처리 응답을 받은 뒤 이벤트 감시를 해제한다. 프로토콜이나 임의 스크립트 실행을 외부 API에 노출하지 않는다.
- 연결 오류: `request <원래 UUID>`로 기록을 확인한다. 대상 부재·중복·가림·읽기 전용·문서 변경은 명시적인 오류다.

로컬 요청 기록은 서버가 입력을 받았는지까지 증명하지 않는다. 외부 서비스의 완료 여부는 해당 사이트의 명확한 완료 신호로 별도 확인해야 한다.

## 검증

```sh
npm run check
npm test
```

테스트는 실제 Electron을 별도 프로필에서 실행해 API·CLI, 입력 이벤트, 대상 오류, 인증 경계, 문서 변경, 재실행 후 기록 유지를 확인한다. 실행 로그·스크린샷·검증 프로필은 ignored `artifacts/` 아래에 보존한다. 테스트 앱은 정상 종료하며 사용자 프로필은 건드리지 않는다.

리뷰 흐름 검사는 외부 서비스를 대신하는 격리된 테스트 페이지와 실제 Electron·API·CLI를 연결한다. 실제 서비스의 DOM 호환성은 `doctor`로 확인한다. 완료를 확인하지 못한 응답은 저장하지 않으며 재전송하지 않는다.

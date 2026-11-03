# 테마 형식

테마 하나 = `themes/<id>/theme.json` 파일 하나 (+ 필요하면 `files/`).
`themes/index.json`에 적힌 순서대로 홈 화면에 나와요.

## 공통 항목

| 항목 | 뜻 |
| --- | --- |
| `no` | 테마 번호 (테마 1, 테마 2…). 없으면 `label`(예: "연습용")을 보여줌 |
| `title`, `subtitle`, `summary`, `credit` | 제목, 부제, 짧은 소개, 제작자 표기 |
| `kind` | `"pdf"` = 원본 PDF를 그대로 보여주는 테마, `"text"` = 내용을 글로 정리한 테마 |
| `players` | `{ "min": 권장 최소, "max": 최대 }` |
| `allowGM` | 진행자(GM)로 참가할 수 있는지 |
| `howto` | 캐릭터 선택 화면에 보이는 '이 테마 진행 방법' |
| `characters` | 캐릭터 목록 (아래) |
| `rounds` | 진행 단계 목록. `{ "name", "minutes", "note", "pick" }` |
| `rooms` | 밀담 장소 (없어도 됨). `{ "id", "name", "cap": 최대 인원(0=제한 없음), "note" }` |
| `vote` | `{ "final": 표가 최종 결정이 되는 캐릭터 id, "allowNone": true면 '범인 없음' 선택지, "noneLabel" }` |
| `cards` | 단서 카드 목록 (없으면 `[]`) |

`pick`: 그 단계에 1인당 가져갈 수 있는 카드 장수. `0`이면 못 가져감, 빼 두면 제한 없음.

## kind: "pdf"

- `files`: `{ "overview": 모두가 보는 개요, "gm": GM 자료, "ending": 엔딩 }`
- 캐릭터마다 `"file"`: 그 캐릭터의 핸드아웃
- `lock`이 있으면 파일이 암호화돼 있어요(`tools/lock-files.ps1`로 만듦). 방을 만들 때 암호가 필요해요.

## kind: "text"

- `intro`: 모두에게 공개되는 사건 개요
- 캐릭터마다 `public`(모두가 아는 모습), `secret`(본인만), `goal`, `timeline`
- `locations`: 카드를 펼칠 장소 `{ "id", "name" }`
- 카드: `{ "id", "round": 펼쳐지는 단계 번호(0부터), "location", "title", "text" }`
- `culprit`: 진범 캐릭터 id, `solution`: 결과 화면의 해설

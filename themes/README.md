# 테마 형식

테마 하나 = `themes/<id>/theme.json` 하나 (+ `files/` 자료, `img/` 초상화).
`themes/index.json`에 적힌 순서대로 홈 화면에 나와요.

## 공통 항목

| 항목 | 뜻 |
| --- | --- |
| `no` | 테마 번호 (테마 1, 테마 2…). 없으면 `label`(예: "연습용")을 보여줌 |
| `title`, `subtitle`, `summary`, `credit` | 제목, 부제, 짧은 소개, 제작자 표기 |
| `kind` | `"pdf"` = 원본 PDF를 그대로 보여주는 테마, `"text"` = 내용을 글로 정리한 테마 |
| `lang` | 자료 언어(`"ja"`면 자료 창에 번역 도움이 나옴) |
| `players` | `{ "min": 권장 최소, "max": 최대 }` |
| `allowGM` | 진행자(GM)로 참가할 수 있는지 |
| `howto` | 캐릭터 선택 화면의 '이 테마 진행 방법' |
| `characters` | 캐릭터 목록. `id, name, sub, note, img` (+ PDF 테마는 `docs`, `cover`, `endDocs`) |
| `rounds` | 진행 단계. `{ "name", "minutes", "note", "pick", "talk" }` |
| `talkMax` | 밀담 최대 인원(나 포함) |
| `rooms` | 장소(없어도 됨). `{ "id", "name", "cap": 최대 인원(0=제한 없음), "note" }` |
| `vote` | `{ "final": 표가 최종 결정이 되는 캐릭터, "allowNone": '범인 없음' 선택지, "noneLabel", "runoff": 동점이면 결선 투표, "noSelf": 자기 자신 투표 금지, "tieText": 동점일 때 결과 이름(예: "동표") }` |
| `cards`, `locations` | 단서 카드와 카드를 펼칠 장소 |
| `cardRules` | `{ "public", "share", "give": false면 그 버튼을 숨김, "note": 안내 }` |
| `relations` | 관계도. 아래 참고 |
| `endNote` | 결과 화면 안내 |

`pick`: 그 단계에 1인당 가져갈 카드 장수. `0`이면 못 가져감, 빼 두면 제한 없음.
`talk: true`인 단계에서만 밀담 채팅을 새로 시작하고 보낼 수 있어요.

## kind: "pdf"

- `docs`: 공용 자료 `{ "id", "title", "file", "show", "from" }`
  - `show`: `always`(선택 화면부터 모두) · `play`(`from` 단계부터 모두) · `gm`(진행자, 결과 후 모두) · `end`(결과 후 모두)
- 캐릭터 `docs`: `[{ "title", "file", "from": 열리는 단계 번호(0부터) }]` — 그 캐릭터를 고른 사람만
- 캐릭터 `cover`: 모두 볼 수 있는 표지, `endDocs`: 결과 후 열리는 자료
- 카드에 `file`을 넣으면 카드를 가져간 사람만 그 PDF를 열 수 있어요. `back`은 카드 뒷면에 적힐 글자.
- `lock`이 있으면 파일이 암호화돼 있어요(`tools/lock-files.ps1`로 만듦).
- 인원별 버전이 있으면 `variants`(`"5"`, `"6"`…)에 `label, players, characters(id 목록), cards`를 두고,
  파일은 `"@키"`로 적어 `fileMap`의 `"<버전>:<키>"`에서 찾아요. 캐릭터 공통 정보는 `characterInfo`, 자료 틀은 `charDocs`·`charCover`·`charEndDocs`.

## kind: "text"

- `intro`: 모두에게 공개되는 사건 개요
- 캐릭터마다 `public`(모두가 아는 모습), `secret`(본인만), `goal`, `timeline`
- 카드: `{ "id", "round": 펼쳐지는 단계 번호, "location", "title", "text" }`
- `culprit`: 진범 캐릭터 id, `solution`: 결과 화면의 해설

## 관계도 (`relations`)

공개된 정보만 넣어요(핸드아웃 내용은 스포일러라 넣지 않음).

- 자유 배치: `people: [{ "id", "x", "y", "name"?, "sub"?, "note"?, "img"?, "victim"? }]`, `links: [{ "a", "b", "label", "at"? }]`, `groups: [{ "label", "x", "y", "w", "h" }]`
  - 캐릭터 id면 이름·초상화를 캐릭터에서 가져오고, 맡은 플레이어 이름이 함께 나와요.
- 가족: `tree: { "parents": [..], "parentsLabel", "children": [..] }` (그 버전에 있는 캐릭터만 그림)

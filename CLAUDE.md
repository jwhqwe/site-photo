# 현장 사진 앱 — 작업 규칙

건설 현장 사진·영상에 도면 위치(핀), 찍은 부재, 방향, 이슈를 붙여 정리하는 1인용 웹앱(PWA)이다. 아이폰 Safari에서 홈 화면에 추가해 쓴다.

## 지켜야 할 것
- 공개 저장소다. 앱 코드만 둔다. 도면(PDF·이미지·도면 패키지 .json), 현장 사진·영상, 내보내기·백업 ZIP, 현장·회사 이름은 커밋하지 않는다.
- 데이터는 폰 안 IndexedDB에만 저장한다. 서버로 보내는 코드, 외부 분석·광고 스크립트를 넣지 않는다.
- 인터넷 없이 동작해야 한다(서비스 워커 sw.js).

## 구조
- 배포: `gh-pages` 브랜치 루트를 GitHub Pages가 그대로 서빙한다. 빌드 단계는 없다.
- `index.html`, `app.css`, `js/main.js`(화면·흐름), `js/plan.js`(도면 보기·확대 시 PDF 벡터 재렌더링), `js/camera.js`(앱 카메라·기본 카메라·나침반), `js/db.js`(IndexedDB), `js/util.js`(이름 규칙·CSV·ZIP), `js/ui.js`(대화상자), `vendor/`(pdf.js 3.11.174).
- 코드를 바꾸면 `sw.js`의 `VERSION` 값을 바꿔야 폰에 새 버전이 들어간다.
- 도면은 앱의 "도면 파일 가져오기"로 폰에서 넣는 패키지(format `fieldphoto-drawings`)에서 온다.

## 확인 방법
- 로컬 HTTP 서버 + 폰 크기(390×844) Chromium, `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`로 촬영 → 위치 → 저장 → 날짜별 → 이슈 조치 → 내보내기 → 백업·복원을 확인한다.
- 실제 카메라 화질, 렌즈 전환, 나침반은 폰에서만 확인할 수 있다.

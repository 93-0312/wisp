# WISP

> 말은 연기처럼, 흔적 없이.

소규모(최대 10명) 익명 채팅 공간. 랜덤 동물 캐릭터로 2D 방을 돌아다니며 말하면,
말풍선이 몇 초 뒤 글자 단위로 흩날려 사라진다.

- **익명**: 가입/로그인 없음. 입장할 때마다 랜덤 닉네임 + 캐릭터
- **무기록**: 서버는 메시지를 전달만 하고 DB·파일·로그에 저장하지 않음. 새로고침하면 아무것도 남지 않음
- **공간**: 클릭 또는 방향키/WASD로 이동, 다른 사람의 움직임이 실시간으로 보임

## 실행

```bash
npm install
npm start
```

http://localhost:3000 접속. 같은 와이파이의 다른 기기는 `http://<내 PC IP>:3000`.

## 구조

```
wisp/
├─ server.js          # Express + Socket.IO, 접속자 위치만 메모리에 보관
└─ public/
   ├─ index.html      # 입장 화면 + 채팅 공간
   ├─ style.css
   └─ client.js       # 이동, 말풍선, 흩날림 효과
```

## 설정값

| 위치 | 값 | 설명 |
|---|---|---|
| `server.js` `MAX_USERS` | 10 | 최대 동시 접속 |
| `server.js` `MAX_MSG_LEN` | 200 | 메시지 길이 제한 |
| `public/client.js` `BUBBLE_MS` | 7000 | 말풍선이 흩어지기까지 시간(ms) |

## 무료 배포 (Render)

1. 이 폴더를 GitHub 저장소로 올린다
2. render.com → New → Web Service → 저장소 연결
3. Build: `npm install`, Start: `npm start`, Instance: Free
4. 생성된 `https://xxx.onrender.com` 링크 공유

무료 플랜은 15분간 접속이 없으면 잠들고, 첫 접속 시 30초 정도 깨어나는 시간이 걸린다.

## 참고

대화 내용은 서버에 남지 않지만, 호스팅 업체의 접속 로그(IP 등)나 화면 캡처까지 막을 수는 없다.

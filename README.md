# Tripmeter Browser SDK

NOL 등 제휴사 웹/웹뷰가 중앙 Tripmeter 수집기로 이벤트를 보내는 독립 SDK입니다.
React, Next.js, Amplitude, 트립스토어 네이티브 브리지를 필요로 하지 않습니다.

## 설치와 초기화

정식 npm 발행 전인 릴리스 후보입니다. 현재 npm에서 설치할 수 없습니다.
승인 후 `@extriber/tripmeter-browser`의 정확한 버전을 고정해 설치합니다.
SDK 소스와 변경 이력은 이 저장소에서 관리합니다.
실제 키는 패키지에 포함되지 않습니다.

```ts
import { createClient } from '@extriber/tripmeter-browser';

const analytics = createClient({
  apiKey: issuedDevelopmentKey,
  bucket: 'channel_nol_dev',
  onError: error => reportSdkError(error.code, error.status),
});
analytics.setUserId(nolUserId);
analytics.identify({ $set: { membership: 'gold', visitCount: 0 } });
analytics.track('product_view', {
  product_id: productId,
  page_path: location.pathname,
  page_url: location.href,
});
await analytics.flush();
```

script 방식은 동일 소스에서 빌드한 `dist/tripmeter.js`를 배포하고
`Tripmeter.createClient(...)`를 호출합니다. 버전이 고정된 파일 URL을 사용합니다.
ESM 파일은 `dist/index.js`, TypeScript 정의는 `dist/index.d.ts`입니다.

`apiKey`와 `bucket`은 필수이며 추정하지 않습니다. 기본 endpoint는
`https://collect.tripstore.kr/tripmeter`입니다. 검증 서버를 사용할 때만
`endpoint`에 같은 경로 구조의 base URL을 지정합니다.
한 페이지에서는 동일 endpoint/bucket에 한 인스턴스만 만들고 재사용합니다.

## 공개 API와 데이터 의미

- `track(name, properties)`: 이벤트를 영속 큐에 기록합니다. 문자열, 유한 숫자,
  boolean, null, 배열과 JSON 객체를 보존합니다. NaN, Infinity, 함수, 순환 객체는
  전송하지 않고 `onError`에 `payload` 오류를 전달합니다.
- `setUserId(id)`: 로그인한 사용자의 안정적인 ID를 문자열로 지정합니다.
- `identify({ $set, $setOnce, $unset })`: 사용자 속성을 변경합니다. `$unset`은
  삭제할 키의 문자열 배열입니다. 0, false, 빈 문자열을 삭제로 해석하지 않습니다.
- `reset()`: 로그아웃 시 호출합니다. 새로운 익명 기기 ID로 전환하고 사용자 ID,
  속성, 세션을 초기화합니다. 이미 큐에 들어간 이벤트의 당시 ID/속성은 유지합니다.
- `setOptOut(true)`: 수집을 멈추고 아직 보내지 않은 큐를 삭제합니다.
  이미 발송한 요청은 취소하거나 회수할 수 없습니다. `false`는 수집을 재개합니다.
- `flush()`: 현재 큐를 전송하고 HTTP 응답을 기다립니다. 실패하면 reject하며,
  미확인 이벤트를 보존합니다. HTTP 성공은 Kafka 수신 확인이며 최종 분석 반영과는 다릅니다.
- `destroy()`: 타이머와 이벤트 리스너를 제거합니다. 큐와 사용자 상태는 남겨
  다음 초기화에서 복구합니다.

세션은 이벤트 기준 30분 초과 비활동 뒤 새로 시작합니다. 정확히 30분이면 유지합니다.
이전 세션 종료 시각은 마지막 활동 +1ms이며 다음 활동 때 기록합니다.
페이지뷰/클릭을 자동 수집하지 않습니다. 업무 이벤트와 필요한 페이지 정보를 명시합니다.
SDK는 기기 UUID, 사용자 ID, 세션, 이벤트 UUID, 시각, 순번과 사용자 속성 스냅샷을 부여합니다.
NOL ID와 트립스토어 ID는 자동 병합하지 않습니다.

## 웹뷰와 전달 계약

HTTPS secure context, JavaScript, localStorage, fetch, crypto.randomUUID,
structuredClone을 지원하는 웹뷰가 필요합니다. Android는 DOM storage를 활성화하고
WKWebView는 영속 data store를 사용해야 재진입 뒤 ID와 큐를 유지할 수 있습니다.
저장 실패 시 메모리 큐나 임의 ID로 우회하지 않습니다. `onError`에 알리고 해당
인스턴스의 수집을 중단합니다. host의 이벤트 핸들러로 수집 오류를 던지지 않습니다.

큐와 상태는 endpoint/bucket별로 격리합니다. API Key는 저장하지 않고 전송 시점에
적용하므로, 같은 bucket에서 키를 교체해도 미전송 이벤트 ID와 사용자 상태가 유지됩니다.
기존 인스턴스를 destroy한 후 새 키로 다시 생성합니다. 개발/운영은 다른 키를 사용합니다.
재전송은 원래 insert_id를 유지합니다. 여러 탭에서 동시에 보내면 재전송이 발생할 수
있으며 서버의 bucket별 이벤트 중복 제거를 사용합니다. exactly-once 전송을 주장하지 않습니다.

정상 상태의 전송 간격은 1초이며 30건 이상이면 전송을 시도합니다.
일시적 전송 실패에는 1초부터 최대 60초까지 간격을 늘립니다.
429는 서버의 Retry-After를 지키고 서버가 안내한 최대 배치 크기를 적용합니다.
400/401/403/410/413/422가 발생하면 자동 재전송을 중지하고 큐는 보존합니다.
원인을 해결한 후 명시적으로 flush하거나 새 키로 인스턴스를 다시 만듭니다. 온라인 복구와
페이지 숨김/종료에도 전송합니다. 종료 전송은 fetch keepalive 크기 제한에 맞춰
작은 배치를 사용하며 큰 이벤트는 다음 일반 전송까지 큐에 남습니다. 강제 종료나
웹뷰 저장소 삭제 후의 전달은 보장하지 않습니다.

수집 전용 키는 브라우저에서 노출됩니다. 조회/관리 자격 증명을 넣으면 안 됩니다.
쿠키는 전송하지 않습니다. 서버가 키와 bucket 조합을 검사하며 401/403을 포함한
실패 이벤트를 임의로 삭제하지 않습니다. 지속 오류는 `onError`와 수집기 상태로 확인합니다.

## 호환성과 검증

현재 트립스토어 웹/앱의 키 전용 요청과 저장소를 변경하지 않습니다. 기존 SDK의
교체나 데이터 이관은 이 패키지에 포함하지 않습니다.

`pnpm --filter @extriber/tripmeter-browser test`는 bucket 격리, 속성 타입,
로그아웃, 세션 경계, 실패 큐 복원, 키 교체, opt-out, 저장 실패 격리를 검증합니다.
`build`, `typecheck`, `lint`를 함께 통과해야 배포합니다. 실제 제휴사 Android/iOS
웹뷰 검증은 해당 앱 환경에서 별도로 수행해야 합니다.

## 수집 제한과 키 운영

현재 트립스토어와 동일하게 요청당 최대 2,000 이벤트, 1MiB 본문 제한을 사용합니다.
키별 분당 상한은 별도 설정이며 미설정(null)은 트립스토어와 동일하게 분당 상한 없음입니다.
분당 상한을 설정하면 모든 서버가 공유하는 UTC 분 단위 카운터를 사용합니다.
재시도도 수신 시도의 이벤트 수로 계산하며 최종 중복 제거 후 건수와는 다릅니다.

실제 개발·운영 키는 별도 전달합니다. NOL 소유 서버/배포 설정에 관리할 수 있으나
브라우저에 주입한 뒤에는 사용자와 제3자가 읽을 수 있는 수집 전용 키입니다.
키 노출로 조회·관리 권한이 생기지는 않습니다. 키 교체 시 이전 키를 유지한 채 새 키로
소비자를 배포하고, 전환 확인 후 이전 키를 차단합니다.

## 문서와 라이선스

[외부 전달 목록](https://github.com/extriber/tripmeter-browser/blob/master/docs/PARTNER-HANDOFF.md) · [릴리스 승인 절차](https://github.com/extriber/tripmeter-browser/blob/master/docs/RELEASING.md)

SDK 자체의 라이선스는 소유자 확정 전입니다. 현재 npm 발행은 차단돼 있습니다.
배포에 포함되는 외부 코드의 고지는 THIRD_PARTY_NOTICES.txt를 참조합니다.

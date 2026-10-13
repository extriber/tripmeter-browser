# 릴리스와 최종 승인

이 저장소에는 SDK 소스만 있습니다. 고객 키와 내부 서버 자격 증명은 넣지 않습니다.
라이선스는 소유자가 승인한 ISC입니다. 패키지 메타데이터는 발행 가능한 상태로 준비합니다.
일반 CI에는 발행 단계가 없습니다. 수동 staging workflow는 GitHub 소유자 승인을 받고,
npm에서도 소유자가 2FA로 최종 승인해야 실제 버전이 공개됩니다. npm 최종 공개는 별도 승인 대상입니다.

## 최초 등록

1. npm 사용자 계정을 만들고 2FA와 복구 수단을 설정합니다. 회사 소유 `@extriber` 조직과 package 관리 권한을 준비합니다.
2. 라이선스·버전·공개할 파일을 검토한 PR을 승인합니다. CI에서 실제 tarball 설치 및 타입 검증이 통과해야 합니다.
3. 아직 registry에 package가 없으므로 소유자가 로그인한 로컬 환경에서 검증한 tarball을 `npm stage publish <file.tgz> --access public --tag next --registry=https://registry.npmjs.org/ --@extriber:registry=https://registry.npmjs.org/`로 최초 등록합니다. 신규 package는 `0.0.0-stage` 이름이 먼저 공개됩니다. 이 작업도 원격 쓰기이며 사용자 승인 없이 실행하지 않습니다.
4. npm package 설정에서 GitHub `extriber/tripmeter-browser`, `stage-release.yml`, environment `npm-stage`를 신뢰하는 publisher를 설정합니다. **stage-only** 권한만 주고 direct publish와 dist-tag 변경은 허용하지 않습니다. 전통적인 token 발행은 차단하며 장기 NPM_TOKEN을 CI에 등록하지 않습니다.
5. GitHub `npm-stage` environment의 승인자는 사용자 본인으로 제한합니다. master에서만 workflow를 실행합니다.

## 이후 릴리스

1. 버전·CHANGELOG·의존성 변경과 호환성을 PR에서 검토합니다. CI 통과 후 source를 병합합니다.
2. master에서 stage-release workflow를 실행합니다. workflow는 검증한 **동일 tgz**를 npm staging에 제출할 뿐 공개하지 않습니다.
3. 소유자가 `npm stage list/view/download`로 해당 artifact를 확인한 후 2FA로 `npm stage approve <id>`를 실행합니다. GitHub 승인만으로 npm 공개가 완료되지 않습니다.
4. rc는 next에만 공개합니다. NOL sandbox와 앱 검증 후 정식 버전도 같은 절차로 제출·승인하며, 소유자가 latest를 변경합니다.
5. npm의 dist.integrity, source commit과 workflow provenance, 배포 버전을 기록합니다. NOL은 정확한 버전과 lockfile을 고정합니다.

문제 버전은 덮어쓸 수 없습니다. 이전 정상 버전으로 소비자 버전을 되돌리고, 문제 버전 deprecate와 새 수정 버전을 사용합니다. latest 변경은 이미 배포된 소비자 코드를 바꾸지 않습니다.

공식 문서: https://docs.npmjs.com/trusted-publishers/ · https://docs.npmjs.com/staged-publishing/

## 로컬 레지스트리 격리

회사 로컬 설정은 `@extriber`를 GitHub Packages로 연결할 수 있습니다. 전역 `.npmrc`는 변경하지 않습니다.
이 SDK의 staging 명령은 일반 registry와 `@extriber:registry`를 모두 npm 공식 주소로 지정합니다.
로그인도 별도 사용자 설정 파일을 사용하면 기존 회사 레지스트리 인증과 분리할 수 있습니다.
기존 설정에서 `--registry` 하나만 덮어쓰면 scoped registry가 우선할 수 있으므로 두 옵션을 유지합니다.

import { createHash, timingSafeEqual } from 'node:crypto';

// 접속 코드 검사. 비용이 드는 모든 서버 경로가 처리 전에 부른다.
// - 환경 변수 ACCESS_CODE가 있으면 요청의 x-access-code 헤더와 같아야 한다.
// - 내 PC에서 돌릴 때는 ACCESS_CODE를 비워 둘 수 있다. 그때는 검사하지 않는다.
// - 배포한 서버(Azure App Service)에서 ACCESS_CODE가 비어 있으면 모두 거절한다.
//   설정을 빠뜨린 채 서버의 키가 열려 있는 일을 막기 위해서다.

const digest = (value: string) => createHash('sha256').update(value).digest();

/** 통과하면 null, 막아야 하면 돌려보낼 응답을 준다. */
export function checkAccess(request: Request): Response | null {
  const expected = process.env.ACCESS_CODE ?? '';
  if (!expected) {
    // WEBSITE_SITE_NAME은 Azure App Service가 넣어 주는 값이다
    if (process.env.WEBSITE_SITE_NAME) {
      return Response.json({ error: '서버에 접속 코드가 설정되어 있지 않습니다.' }, { status: 503 });
    }
    return null;
  }
  const given = request.headers.get('x-access-code') ?? '';
  if (timingSafeEqual(digest(given), digest(expected))) return null;
  return Response.json({ error: '접속 코드가 맞지 않습니다.' }, { status: 401 });
}

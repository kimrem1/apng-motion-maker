/**
 * 가리기 마스크.
 *
 * 이미지 레이어와 도형 레이어가 **같은 조각**을 쓴다. 두 벌이 되면 같은 프리셋이
 * 이미지에서는 왼쪽부터, 도형에서는 오른쪽부터 열리는 사고가 난다.
 *
 * 세 가지가 이 파일의 계약이다.
 *
 * 1. **좌표는 레이어 로컬이다.** v_uv 는 회전과 확대를 따라 도는 유닛 사각형이므로,
 *    카드를 45도 기울이면 경계선도 함께 기운다. 사람들이 기대하는 것이 그쪽이다.
 *    "화면 기준" 와이프가 필요하면 레이어 회전을 0 으로 두면 된다.
 *
 * 2. **알파에 스칼라로 곱한다.** 출력이 premultiplied 이므로 rgb 와 a 에 같은 배수를
 *    걸어야 rgb <= a 불변식이 유지된다. 호출부는 premultiply **직전**에 곱한다.
 *
 * 3. **진행률 0 과 1 은 부드러움과 무관하게 완전히 가려지고 완전히 보인다.**
 *    smoothstep 을 그대로 쓰면 부드러움을 올릴수록 진행률 1 에서도 가장자리가
 *    반투명하게 남는다. 그래서 진행률을 [-soft, 1+soft] 로 미리 늘려 둔다.
 */

export const REVEAL_GLSL = /* glsl */ `
uniform int u_revealMode;
uniform float u_reveal;
uniform float u_revealSoft;
uniform float u_revealSlats;
uniform float u_revealAngle;
uniform float u_revealFlip;

const float MM_TAU = 6.28318530718;

/*
 * 픽셀마다 "몇 시에 드러나는가" 를 0~1 로 매긴다.
 * 진행률이 이 값을 넘어서면 그 픽셀이 보인다.
 */
float mmRevealField(vec2 uv) {
  if (u_revealMode == 1) return uv.x;
  if (u_revealMode == 2) return 1.0 - uv.x;
  if (u_revealMode == 3) return uv.y;
  if (u_revealMode == 4) return 1.0 - uv.y;
  if (u_revealMode == 5) return abs(uv.x - 0.5) * 2.0;
  if (u_revealMode == 6) return abs(uv.y - 0.5) * 2.0;
  if (u_revealMode == 7) {
    // 0.70710678 = 중심에서 모서리까지. 진행률 1 에서 네 귀퉁이가 정확히 열린다.
    return length(uv - 0.5) / 0.70710678;
  }
  if (u_revealMode == 8) {
    vec2 d = uv - 0.5;
    // atan(x, -y) 는 12시가 0 이고 시계 방향이 양수다 (화면 y 축이 아래로 향한다).
    float a = atan(d.x, -d.y) - u_revealAngle;
    return a / MM_TAU - floor(a / MM_TAU);
  }
  if (u_revealMode == 9) {
    float n = max(1.0, u_revealSlats);
    float y = uv.y * n;
    return y - floor(y);
  }
  return 0.0;
}

float mmRevealMask(vec2 uv) {
  if (u_revealMode == 0) return 1.0;

  float t = clamp(u_reveal, 0.0, 1.0);

  float g = mmRevealField(uv);
  /*
   * 뒤집기는 **진행률이 아니라 경계선이 지나가는 방향**을 바꾼다.
   *
   * t 를 1-t 로 뒤집으면 와이프가 거꾸로 재생될 뿐이라 어느 쪽이 먼저 드러나는지는
   * 그대로다. 게다가 진행률 트랙이 없는(항등값 1) 레이어가 통째로 사라진다.
   * 되감기는 이미 트랙이 하는 일이다(1 -> 0 키를 찍으면 된다). 여기서는 필드를
   * 뒤집어 "반대쪽에서 열리기" 를 만든다. 그래야 진행률 0 = 완전히 가려짐,
   * 1 = 전부 보임이라는 계약이 뒤집기와 무관하게 유지된다.
   */
  if (u_revealFlip > 0.5) g = 1.0 - g;

  // 부드러움 0 일 때도 계단이 보이지 않게 아주 얇은 폭은 남긴다.
  float w = max(clamp(u_revealSoft, 0.0, 1.0) * 0.5, 1e-4);
  /*
   * 양끝을 **실제 smoothstep 폭만큼** 민다. 부드러움이 아니라 w 로 미는 것이 핵심이다.
   * 부드러움 0 일 때 두 값이 어긋나면 진행률 0 에서 경계선 위 픽셀이 0.5 로 남는다.
   */
  float tt = t * (1.0 + 2.0 * w) - w;

  return smoothstep(g - w, g + w, tt);
}
`

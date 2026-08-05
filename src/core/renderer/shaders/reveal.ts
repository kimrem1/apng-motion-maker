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
 * 반 바퀴. MM_PI 라는 이름은 쓸 수 없다.
 *
 * 이 조각은 도형 셰이더에 **통째로 삽입되는데** 그쪽이 이미 MM_PI 를 선언하고 있다.
 * 같은 이름을 두 번 선언하면 GLSL 은 재정의 오류로 컴파일을 거부하고, 도형 레이어가
 * 통째로 안 그려진다. 공유 조각은 이름 하나까지 남의 자리를 침범하지 않아야 한다.
 */
const float MM_HALF_TURN = 3.14159265359;

/*
 * 잉크 얼룩용 값 노이즈.
 *
 * 이펙트 쪽 노이즈 아틀라스를 쓰지 않는다. 가리기는 이미지 / 도형 / 글자 셰이더
 * **셋 다**에 들어가는 조각이라, 텍스처를 하나 더 물리면 세 파이프라인 모두가
 * 유닛을 하나씩 더 잡아먹는다. 가리기 하나 때문에 치를 값이 아니다.
 *
 * u_revealMode 는 유니폼이므로 아래 분기는 워프 안에서 갈리지 않는다. 잉크를
 * 안 쓰는 레이어에서 이 계산의 비용은 정확히 0 이다.
 */
float mmRevealHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float mmRevealNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // 스무스스텝 보간. 선형으로 두면 격자선이 마름모꼴로 드러난다.
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = mmRevealHash(i);
  float b = mmRevealHash(i + vec2(1.0, 0.0));
  float c = mmRevealHash(i + vec2(0.0, 1.0));
  float d = mmRevealHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** 4 옥타브. 합이 0.9375 라 나눠서 0~1 로 되돌린다. */
float mmRevealFbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i += 1) {
    v += amp * mmRevealNoise(p);
    p *= 2.0;
    amp *= 0.5;
  }
  return v / 0.9375;
}

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
  if (u_revealMode == 10) {
    /*
     * 잉크. 가운데에서 자라는 것은 iris 와 같고 경계가 들쭉날쭉한 것만 다르다.
     *
     * 노이즈만 쓰면 얼룩이 온 화면에 **동시에** 피어올라 번지는 것으로 안 보인다.
     * 그래서 반지름을 뼈대로 깔고 노이즈를 45% 만 섞는다. 이 비율이 경계다.
     * 더 섞으면 순서가 무너지고 덜 섞으면 그냥 둥근 원이다.
     */
    float scale = max(1.0, u_revealSlats) * 0.5;
    float n = mmRevealFbm(uv * scale);
    float radial = length(uv - 0.5) / 0.70710678;
    return clamp(mix(radial, n, 0.45), 0.0, 1.0);
  }
  if (u_revealMode == 11) {
    /*
     * 부채. 손잡이가 **아래 변의 가운데**다.
     *
     * clock 과 한가운데를 나눠 쓰지 않는 이유가 여기다. 부채도 아치도 무지개도
     * 회전축이 그림 한복판이 아니라 아래 끝에 있다. 한복판을 돌리면 아래쪽 절반이
     * 먼저 열려 버려서 "펼쳐진다" 가 아니라 "돌아간다" 로 보인다.
     */
    vec2 d = vec2(uv.x - 0.5, uv.y - 1.0);
    // 오른쪽이 0, 위가 pi/2, 왼쪽이 pi. uv 가 [0,1] 이라 -d.y 는 언제나 0 이상이다.
    float a = atan(-d.y, d.x);
    return 1.0 - a / MM_HALF_TURN;
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

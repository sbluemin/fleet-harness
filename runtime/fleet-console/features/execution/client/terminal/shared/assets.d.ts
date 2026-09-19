declare module "*.css";

// Vite의 ?url 자산 import — 처리된 파일의 same-origin 경로를 돌려준다(아티팩트 서체 시트 브리지).
declare module "*.css?url" {
  const url: string;
  export default url;
}

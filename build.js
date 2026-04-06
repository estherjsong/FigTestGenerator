const esbuild = require('esbuild');
const fs = require('fs');

try {
  // 1. code.ts 빌드 (Figma 시스템용)
  esbuild.buildSync({
    entryPoints: ['code.ts'],
    bundle: true,
    outfile: 'code.js',
    target: 'es2017',
    format: 'iife'
  });

  // 2. ui.ts 빌드 결과를 텍스트로 추출
  const uiResult = esbuild.buildSync({
    entryPoints: ['ui.ts'],
    bundle: true,
    write: false,
    target: 'es2017',
    format: 'iife'
  });
  const uiJsCode = uiResult.outputFiles[0].text;

  // 3. ui.html을 읽어서 자바스크립트를 HTML 내부에 직접 삽입 (인라인)
  let html = fs.readFileSync('ui.html', 'utf8');

  // 기존 연결 링크나 이전 주입 코드 완전히 삭제
  html = html.replace(/<script src="\.\/ui\.js"><\/script>/g, '');
  html = html.replace(/<script id="injected-script">[\s\S]*?<\/script>/g, '');

  // </body> 바로 위에 스크립트를 통째로 박아넣기!
  html = html.replace('</body>', `<script id="injected-script">\n${uiJsCode}\n</script>\n</body>`);

  fs.writeFileSync('ui.html', html);
  console.log("🚀 빌드 대성공: 모든 자바스크립트가 ui.html 안에 완벽하게 합쳐졌습니다!");
} catch (error) {
  console.error("빌드 실패:", error);
  process.exit(1);
}
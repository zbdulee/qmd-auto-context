// 테스트 공용 임시 디렉터리 / HOME 격리 헬퍼.
//
// 이 디렉터리의 *.py 는 stub 데몬 driver(capture_query.py 등)이고, 이 모듈은 JS 테스트가
// 공유하는 정리·격리 유틸이다. 두 실측 사고를 한 곳에서 막는다:
//
//  (1) 실제 HOME 오염 — core/config.py 의 로컬 optout 마커는 `Path.home()` 하위
//      (`~/.config/qmd/optout/<sha256>.json`)에 쓰인다. 제품 코드로는 이게 옳다(훅 런타임의
//      HOME 이어야 한다). 그런데 `Path.home()` 은 `HOME` env 를 따르므로, 테스트가 프로젝트
//      cwd 만 임시로 만들고 HOME 을 실제 값으로 두면 마커가 사용자 홈에 **영구 누적**된다
//      (리퍼가 없다 — 실측 1,972개 / 7.7MB, 전체 테스트 실행마다 +4).
//      `find_local_optout` 은 직접 해시가 안 맞으면 마커 디렉터리 전체를 glob 해 읽으므로
//      누적은 용량 문제로 끝나지 않고 모든 훅 호출의 비용이 된다.
//      → HOME 하위 상태(optout / skip / notice 마커 …)를 건드리는 테스트는 반드시
//        `isolatedHomeProject()` 로 가짜 HOME 을 만들고 자식 프로세스 env 에 넘긴다.
//        **이 격리를 지우지 말 것.** 지우면 조용히 사용자 홈에 쓰기 시작한다.
//
//  (2) 정리 경합(ENOTEMPTY/EBUSY) — detached 백그라운드 fork(update.sh --worker 의 embed
//      서브셸 등)가 호출자 반환 뒤에도 workdir 에 쓰고 `rmSync` 와 경합해 전체 실행 5회 중
//      1회 실패했다(격리 실행은 통과 → 병렬 부하 타이밍). `removeTemp()` 가 그 재시도를
//      한 곳에 담는다. 맨 `rmSync(dir, {recursive:true, force:true})` 를 새로 쓰지 말고
//      이걸 쓴다.

// 참고: `node --test`(인자 없음)의 기본 discovery 패턴에는 `**/test/**/*.?(c|m)js` 가 있어
// 이 모듈도 "테스트 파일 1개"로 로드된다(테스트 0개 → 파일 단위 pass 1줄). 부작용이 없는
// 순수 export 모듈이므로 무해하며, 전체 요약의 tests/pass 가 각각 +1 되는 것이 그 때문이다.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 임시 디렉터리를 지운다. ENOTEMPTY/EBUSY 면 짧게 자고 최대 20회 재시도하고,
 * 그 외 에러는 그대로 던진다(권한/경로 오류를 삼키면 진단이 사라진다).
 */
export function removeTemp(dir) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== 'ENOTEMPTY' && err.code !== 'EBUSY') throw err;
      execFileSync('sleep', ['0.05']);
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * 임시 디렉터리 base. `~/.cache` 를 쓴다 — repo 하위는 저장소 루트의 dogfooding
 * `.auto-context/settings.json` 을 부모 상속하고, `tmpdir()`(macOS `/private/tmp`)는
 * `resolve_paths.is_risky_path` 가 refused 로 만든다.
 */
export function tempBase() {
  const base = join(homedir(), '.cache');
  mkdirSync(base, { recursive: true });
  return base;
}

/** `~/.cache` 하위 임시 디렉터리(HOME 격리가 필요 없는 테스트용). */
export function repoTemp(prefix) {
  return mkdtempSync(join(tempBase(), `qmd-test-${prefix}-`));
}

/**
 * `update.sh` 계열에 넘길 `QMD_CACHE_DIR` 용 임시 캐시 디렉터리(파일당 1개면 충분).
 *
 * 기본값은 `$HOME/.cache/qmd` 이고 거기에 `notice_once` TTL marker
 * (`notice-<key>-<sha256(project)[:16]>`), `update-status-*`, `hook.log` 가 떨어진다.
 * 프로젝트 경로가 매 테스트마다 새 temp 디렉터리라 해시가 매번 달라 marker 가 사용자 홈에
 * 계속 쌓였다(실측 5,100개). **workdir 안에 두면 안 된다** — `update.sh` main 은 detached
 * 백그라운드 worker 를 fork 하고 그 worker 가 cleanup 이 끝난 뒤에도 `hook.log` 를 써서
 * 지운 workdir 을 되살린다(실측: 지워진 자리에 `cache/hook.log` 만 남은 디렉터리 잔해).
 * 그래서 HOME 밖 · workdir 밖인 시스템 tmpdir 에 둔다(OS 가 정리하고, 늦게 되살아나도
 * 사용자 홈이 아니다). HOME 자체는 바꾸지 않는다 — `_project_search_dirs` /
 * `find_git_root` 가 HOME 경계까지 올라가므로 탐색 모양이 달라진다.
 */
export function tempCacheDir(prefix = 'cache') {
  const dir = mkdtempSync(join(tmpdir(), `qmd-test-cache-${prefix}-`));
  process.on('exit', () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return dir;
}

/** 자식 프로세스 env: HOME/QMD_CACHE_DIR 을 가짜 HOME 으로 고정한다. */
export function isolatedEnv(home, extra = {}) {
  return { ...process.env, HOME: home, QMD_CACHE_DIR: home, ...extra };
}

/**
 * 실제 HOME 과 격리된 가짜 HOME + 그 **하위** 프로젝트 디렉터리를 만든다.
 *
 * 프로젝트를 가짜 HOME 하위에 두는 것이 핵심이다 — `config._project_search_dirs` /
 * `project_identity_root` / `resolve_paths.find_git_root` 가 "cwd 에서 HOME 경계까지"
 * 올라가므로, 프로젝트가 HOME 밖이면 탐색 모양이 실사용과 달라진다(실사용 프로젝트는
 * 거의 항상 HOME 하위다). 이렇게 두면 마커·프로젝트가 한 트리에 있어 `removeTemp(home)`
 * 한 번으로 둘 다 사라진다.
 *
 * @returns {{home: string, dir: string, env: (extra?: object) => object}}
 */
export function isolatedHomeProject(prefix, projectName = 'project') {
  const home = realpathSync(mkdtempSync(join(tempBase(), `qmd-home-${prefix}-`)));
  const dir = join(home, projectName);
  mkdirSync(dir, { recursive: true });
  return { home, dir, env: (extra = {}) => isolatedEnv(home, extra) };
}

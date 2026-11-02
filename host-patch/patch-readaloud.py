# -*- coding: utf-8 -*-
"""ZCode app.asar 朗读按钮注入工具。

用法：
  python patch-readaloud.py selftest [--asar <app.asar>]
  python patch-readaloud.py install  [--asar <app.asar>]
  python patch-readaloud.py remove   [--asar <app.asar>]
  python patch-readaloud.py check    [--asar <app.asar>]

设计要点（与 zusage patch_install.py 的差异，均为有意为之）：
  1. 不做 pending / .tmp 待替换：端点自动更新走 generic feed，pending 的旧 asar 会在
     下次启动时覆盖新版本 = 整份客户端降级。客户端运行中一律拒绝安装，提示先退出。
  2. 不做备份回滚：resources/app.asar.orig 与 *.bak-* 都比现役 asar 旧一个月，用它们
     覆盖同样等于降级。回滚只做 strip-only（删掉自己的注入行）。
  3. 安装是「同目录 stage 文件 → 校验 → 原子 rename」的单次事务：进程中途死掉只会留下
     一个 .readaloud-stage 残留文件，永远不会被自动应用。
  4. 注入行按正则识别（唯一 token readaloud-loader.cjs），装完断言恰好 1 处；
     重复行用 re.sub 清理，绝不按「是否在尾部」判断（zusage 每 60s 自动重装会把我们的
     行挤到非尾部，按尾部判断会重复追加）。
  5. 入口语法检查用 .mjs 副本（入口是 ESM，.js 后缀下 node --check 的模块判定不可靠），
     双通道：ELECTRON_RUN_AS_NODE=1 ZCode.exe --check + node --check。
  6. `check` 的退出码：0=PASS，1=FAIL，3=NOT-INSTALLED（未注入）。官方升级会整包替换
     app.asar，此时再亮绿灯会误导；3 只表示「功能不在」，不阻断任何写入操作。
"""
import argparse
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------- 常量

HERE = Path(__file__).resolve().parent
ENTRY = "out/main/index.js"
LOADER = HERE / "readaloud-loader.cjs"
RENDERER = HERE / "readaloud-renderer.js"
STATE_DIR = HERE / "state"
PRISTINE_FILE = STATE_DIR / "entry-pristine.json"

IS_WIN = sys.platform == "win32"
EXE_NAME = "ZCode.exe" if IS_WIN else "zcode"

# 下面两个只是本机默认安装位置、作为最后兜底：
#   其它机器请设环境变量 ZCODE_EXE（可执行文件）/ READALOUD_ASAR（asar 路径），或传 --asar。
#   解析顺序见 resolve_asar / resolve_zcode_exe。
DEFAULT_ASAR = Path(r"D:\ZCode\resources\app.asar")
DEFAULT_ZCODE_EXE = Path(r"D:\ZCode\ZCode.exe")

ALIGN = 4
BLOCK = 4194304          # integrity blockSize，与 asar 默认一致
COPY_CHUNK = 1024 * 1024  # 流式拷贝块大小（不整包 join）

STAGE_NAME = "app.asar.readaloud-stage"

# 注入行：ESM 入口用 dynamic import（CJS/ESM 通用），指向 .cjs loader
OUR_LINE_TMPL = (
    '\n;import("{url}").then(() => null, (e) => console.error("[readaloud] load failed", e));'
)
OUR_LINE = OUR_LINE_TMPL.format(url=LOADER.as_uri())
OUR_LINE_B = OUR_LINE.encode("utf-8")

# 宽松匹配任何目录的朗读注入行（迁移/换目录/重复安装时都能认出来）
OUR_RE = re.compile(
    rb'\n;import\("[^"]*readaloud-loader\.cjs"\)\.then\(\(\) => null, '
    rb'\(e\) => console\.error\("\[readaloud\] load failed", e\)\);'
)
# 自洽性（selftest 会断言）：正则必须认得自己写出去的那行
assert OUR_RE.search(OUR_LINE_B), "OUR_RE 与 OUR_LINE 不自洽"
# zusage 的行：只用于「装完断言它还在」，绝不清除
ZUSAGE_RE = re.compile(
    rb'\n;import\("[^"]*inject-main\.cjs"\)\.then\(\(\) => null, '
    rb'\(e\) => console\.error\("\[zusage\] load failed", e\)\);'
)


def L(zh, en=""):
    return zh


def _p(msg):
    print(msg, flush=True)


def ok(msg):
    _p("  PASS  " + msg)


def bad(msg):
    _p("  FAIL  " + msg)


def info(msg):
    _p("  ..    " + msg)


# ---------------------------------------------------------------- asar 读写

def read_header(f):
    f.seek(0)
    raw = f.read(16)
    if len(raw) < 16:
        raise ValueError("asar 头部过短")
    a, b, c, d = struct.unpack("<4I", raw)
    if a != 4:
        raise ValueError("unexpected pickle prefix %r" % (a,))
    header = json.loads(f.read(d))
    return header, 8 + b


def iter_files(node, path=""):
    """按 header 里的顺序 yield (asar 内路径, node)。"""
    for name, child in node.get("files", {}).items():
        p = path + "/" + name
        if "files" in child:
            yield from iter_files(child, p)
        else:
            yield p, child


def compute_integrity(data):
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": BLOCK,
        "blocks": [hashlib.sha256(data[i:i + BLOCK]).hexdigest()
                   for i in range(0, len(data), BLOCK)],
    }


def _guard_repack_paths(src_path, dst_path):
    """校验 repack 的源/目标路径，返回 (src_p, dst_p)；不合法直接抛 ValueError。

    只允许写两类目录：
      1) 与源 asar 同目录——install/remove 先写 app.asar.readaloud-stage，校验后再原子 rename；
      2) 系统临时目录之下——selftest 在 tempfile.mkdtemp() 的 workdir 里演练重打包。
    其余目录一律拒绝，避免参数被误传时把 asar 写到任意位置。
    """
    src_p = Path(src_path).resolve()
    if not src_p.is_file():
        raise ValueError("源 asar 不存在或不是普通文件: %s" % src_p)
    dst_p = Path(dst_path).resolve()
    if not dst_p.is_absolute():
        raise ValueError("拒绝写入非绝对路径: %s" % dst_p)
    temp_root = Path(tempfile.gettempdir()).resolve()
    # 目标目录白名单：与源同目录，或位于系统临时目录之下（含临时目录本身）。
    if dst_p.parent != src_p.parent and temp_root not in dst_p.parent.parents and dst_p.parent != temp_root:
        raise ValueError("拒绝写入非预期目录: %s" % dst_p)
    # 文件名白名单：常规 .asar，或 stage 中间文件（STAGE_NAME = app.asar.readaloud-stage）。
    if not (dst_p.name.endswith(".asar") or dst_p.name.endswith("-stage")):
        raise ValueError("拒绝写入非预期文件名: %s" % dst_p)
    return src_p, dst_p


def repack(src_path, modify, dst_path):
    """重建 asar。modify: {asar内路径: bytes}。流式拷贝，不把 payload join 进内存。

    偏移必须「先全部算完再写 header」，所以第一遍只读 header 里的 size，
    第二遍才从源文件 seek+copy。未修改文件的偏移/大小/integrity 原样保留。
    """
    _, dst_p = _guard_repack_paths(src_path, dst_path)   # 写盘前先卡路径
    with open(src_path, "rb") as src:
        header, base = read_header(src)
        header = json.loads(json.dumps(header))       # 深拷贝，保留键顺序
        order = list(iter_files(header))
        known = {p for p, _ in order}
        missing = set(modify) - known
        if missing:
            raise ValueError("路径不在 asar 内: %s" % sorted(missing))

        offset = 0
        layout = []
        for p, node in order:
            if node.get("unpacked"):
                node["offset"] = "0"
                layout.append((p, node, None, None))
                continue
            src_off = int(node["offset"])
            if p in modify:
                data = modify[p]
                node["size"] = len(data)
                node["integrity"] = compute_integrity(data)
            size = int(node["size"])
            node["offset"] = str(offset)
            layout.append((p, node, size, src_off))
            offset += size

        header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        d = len(header_bytes)
        c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
        b_total = c + 4

        with open(dst_p, "wb") as out:
            out.write(struct.pack("<4I", 4, b_total, c, d))
            out.write(header_bytes)
            out.write(b"\0" * (c - d - 4))
            if out.tell() != 8 + b_total:
                raise ValueError("header 对齐异常: %d vs %d" % (out.tell(), 8 + b_total))
            for p, node, size, src_off in layout:
                if size is None:
                    continue
                if p in modify:
                    out.write(modify[p])
                    continue
                src.seek(base + src_off)
                left = size
                while left > 0:
                    chunk = src.read(min(COPY_CHUNK, left))
                    if not chunk:
                        raise ValueError("源文件在 %s 处提前结束" % p)
                    out.write(chunk)
                    left -= len(chunk)
    return dst_path


def entry_bytes_of(asar_path):
    with open(asar_path, "rb") as f:
        header, base = read_header(f)
        nodes = dict(iter_files(header))
        node = nodes["/" + ENTRY]
        f.seek(base + int(node["offset"]))
        data = f.read(int(node["size"]))
        if len(data) != int(node["size"]):
            raise ValueError("入口读取不完整")
        return data


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(BLOCK), b""):
            h.update(chunk)
    return h.hexdigest()


def flatten(asar_path):
    """返回 (顺序列表 [(path,node)], dict path->node, 文件数)。"""
    with open(asar_path, "rb") as f:
        header, _ = read_header(f)
    order = list(iter_files(header))
    return order, dict(order), len(order)


def payload_base(asar_path):
    """数据区起点（header 之后的偏移）。"""
    with open(asar_path, "rb") as f:
        _, base = read_header(f)
    return base


def compare_segment(path_a, start_a, path_b, start_b, length):
    """比较两个文件从各自起点开始的 length 字节。返回 True=完全相同。

    一次开文件、顺序读，绝不「每文件重读一次 header」（8MB header × 数万文件 = 灾难）。
    """
    if length <= 0:
        return True
    with open(path_a, "rb") as fa, open(path_b, "rb") as fb:
        fa.seek(start_a)
        fb.seek(start_b)
        left = length
        while left > 0:
            want = min(COPY_CHUNK, left)
            ca = fa.read(want)
            cb = fb.read(want)
            if ca != cb:
                return False
            if not ca:
                return False
            left -= len(ca)
    return True


# ---------------------------------------------------------------- 环境检查

def resolve_asar(explicit):
    if explicit:
        return Path(explicit).resolve()
    env = os.environ.get("READALOUD_ASAR")
    if env:
        return Path(env).resolve()
    return DEFAULT_ASAR


def resolve_zcode_exe(asar_path):
    # 1) 环境变量优先。ZCODE_EXE 是通用名；READALOUD_ZCODE_EXE 是旧名，保留兼容。
    for name in ("ZCODE_EXE", "READALOUD_ZCODE_EXE"):
        env = os.environ.get(name)
        if env and Path(env).is_file():
            return Path(env)
    # 2) 从 asar 位置反推 <root>/ZCode.exe（resources/app.asar 的上一级）
    cand = asar_path.parent.parent / EXE_NAME
    if cand.is_file():
        return cand
    # 3) 最后兜底到本机默认路径（其它机器多半走不到这里：设 ZCODE_EXE 或 --asar）
    if IS_WIN and DEFAULT_ZCODE_EXE.is_file():
        return DEFAULT_ZCODE_EXE
    return None


def client_running():
    """ZCode 是否在跑。查不到时按「在跑」处理（保守，走拒绝路径）。"""
    try:
        if IS_WIN:
            out = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq ZCode.exe", "/NH"],
                capture_output=True, text=True, encoding="gbk", errors="replace",
            ).stdout or ""
            return "ZCode.exe" in out
        return subprocess.run(["pgrep", "-x", "ZCode"], capture_output=True).returncode == 0
    except Exception:
        return True


def is_live_target(asar_path):
    """目标是不是「现役安装」的 asar。

    P0 只在动现役包时拒绝运行中安装；副本演练（--asar 指向临时目录）不适用——
    运行中的客户端根本没在读那份副本。
    """
    try:
        if DEFAULT_ASAR.exists() and asar_path.resolve() == DEFAULT_ASAR.resolve():
            return True
    except OSError:
        pass
    exe = asar_path.parent.parent / EXE_NAME
    ref = resolve_zcode_exe(DEFAULT_ASAR)
    try:
        if exe.exists() and ref is not None and ref.is_file() and exe.resolve() == ref.resolve():
            return True
    except OSError:
        pass
    return False


def guard_client_running(asar_path, action):
    """现役目标 + 客户端在跑 → 拒绝。返回 True=放行。"""
    if not client_running():
        return True
    if is_live_target(asar_path):
        bad("ZCode 正在运行，拒绝%s。" % action)
        info("请完全退出 ZCode（含托盘/后台进程）后再运行本命令。")
        info("（不做 .tmp 待替换：自动更新会让 pending 的旧 asar 覆盖新版本 = 客户端降级）")
        return False
    info("目标不是现役安装（%s），跳过「运行中」检查——这是副本演练路径。" % asar_path)
    return True


def target_writable(asar_path):
    try:
        with open(asar_path, "ab"):
            pass
        return True
    except OSError as e:
        info("目标不可写：%s" % e)
        return False


def load_pristine_map():
    try:
        raw = PRISTINE_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def get_pristine(asar_path):
    return load_pristine_map().get(str(asar_path))


def set_pristine(asar_path, digest):
    data = load_pristine_map()
    key = str(asar_path)
    if key in data:
        return False
    data[key] = digest
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PRISTINE_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return True


def syntax_check_entry(data, exe, label="entry"):
    """把入口写成 .mjs 再检查（入口是 ESM，.js 后缀下 node 的模块判定不可靠）。
    双通道：Electron（有就用）+ node（有就用）。任一可用即返回其结果。"""
    fd, name = tempfile.mkstemp(prefix="readaloud-entry-", suffix=".mjs")
    path = Path(name)
    results = []
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)

        electron_ok = None
        if exe and Path(exe).is_file():
            env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
            try:
                r = subprocess.run([str(exe), "--check", str(path)], capture_output=True,
                                   text=True, encoding="utf-8", errors="replace",
                                   env=env, timeout=180)
                electron_ok = r.returncode == 0
                results.append("electron --check exit=%d %s" %
                               (r.returncode, (r.stderr or "").strip()[:200]))
            except (OSError, subprocess.SubprocessError) as e:
                results.append("electron --check 无法执行: %s" % e)

        node_ok = None
        node_exe = None
        for cand in ("node", "node.exe"):
            try:
                probe = subprocess.run([cand, "--version"], capture_output=True, text=True, timeout=20)
                if probe.returncode == 0:
                    node_exe = cand
                    break
            except (OSError, subprocess.SubprocessError):
                continue
        if node_exe:
            try:
                r = subprocess.run([node_exe, "--check", str(path)], capture_output=True,
                                   text=True, encoding="utf-8", errors="replace", timeout=180)
                node_ok = r.returncode == 0
                results.append("node --check exit=%d %s" %
                               (r.returncode, (r.stderr or "").strip()[:200]))
            except (OSError, subprocess.SubprocessError) as e:
                results.append("node --check 无法执行: %s" % e)

        passed = True
        if electron_ok is not None:
            passed = passed and electron_ok
        if node_ok is not None:
            passed = passed and node_ok
        if electron_ok is None and node_ok is None:
            return None, "%s: 无可用检查器（跳过）" % label
        return passed, "%s: %s" % (label, "; ".join(results))
    finally:
        path.unlink(missing_ok=True)


# ---------------------------------------------------------------- 注入行处理

def strip_ours(data):
    """移除所有朗读注入行，返回 (stripped, 移除条数)。"""
    stripped, n = OUR_RE.subn(b"", data)
    return stripped, n


def our_line_count(data):
    return len(OUR_RE.findall(data))


def zusage_line_count(data):
    return len(ZUSAGE_RE.findall(data))


def build_new_entry(old_entry):
    """返回 (new_entry, stripped, removed_count)。"""
    stripped, removed = strip_ours(old_entry)
    if stripped != old_entry and removed:
        info("清理了 %d 条历史朗读注入行（可能指向旧目录）" % removed)
    new_entry = stripped + OUR_LINE_B
    return new_entry, stripped, removed


# ---------------------------------------------------------------- 校验注入行

def validate_entry_pair(old_entry, new_entry, stripped):
    """注入不变量。任一条不成立就抛 AssertionError。"""
    n = our_line_count(new_entry)
    assert n == 1, "注入后朗读行数量应为 1，实际 %d" % n
    if OUR_LINE_B in new_entry:
        assert new_entry.count(OUR_LINE_B) == 1, "精确匹配的朗读行出现多份"
    # strip 不变量：把唯一那行删掉，必须回到 stripped
    assert new_entry.replace(OUR_LINE_B, b"", 1) == stripped, "strip 不变量不成立"
    if our_line_count(old_entry) == 0:
        assert stripped == old_entry, "原 entry 无朗读行时 stripped 必须等于原 entry"
    # zusage 行不得受影响
    before_z = zusage_line_count(old_entry)
    after_z = zusage_line_count(new_entry)
    assert after_z == before_z, "zusage 行数变化（%d -> %d）" % (before_z, after_z)
    return True


# ---------------------------------------------------------------- 安装事务

def publish_stage(stage, asar_path, stage_meta):
    """校验 stage 后原子替换。返回是否成功。"""
    info("校验 stage 包 ...")
    try:
        order_stage, nodes_stage, count_stage = flatten(stage)
        order_orig, nodes_orig, count_orig = flatten(asar_path)
    except (OSError, ValueError, KeyError, struct.error) as e:
        bad("stage 包无法解析：%s" % e)
        return False
    if count_stage != count_orig:
        bad("文件数变化：%d -> %d" % (count_orig, count_stage))
        return False
    if "/" + ENTRY not in nodes_stage:
        bad("stage 包缺少入口 %s" % ENTRY)
        return False

    stage_entry = entry_bytes_of(stage)
    if stage_entry != stage_meta["entry"]:
        bad("stage 入口字节与预期不一致")
        return False
    expect_ours = int(stage_meta.get("ours", 1))
    if our_line_count(stage_entry) != expect_ours:
        bad("stage 入口朗读行数量 %d，期望 %d" % (our_line_count(stage_entry), expect_ours))
        return False
    if zusage_line_count(stage_entry) != stage_meta["zusage"]:
        bad("stage 入口 zusage 行数量变化")
        return False

    passed, detail = syntax_check_entry(stage_entry, stage_meta["exe"])
    if passed is False:
        bad("stage 入口语法检查失败：%s" % detail)
        return False
    info(detail)

    info("原子替换 %s ..." % asar_path)
    try:
        os.replace(stage, asar_path)
    except OSError as e:
        bad("替换失败：%s" % e)
        return False
    return True


def verify_installed(asar_path, expect_ours, expect_zusage):
    try:
        entry = entry_bytes_of(asar_path)
    except (OSError, ValueError, KeyError, struct.error) as e:
        bad("回读入口失败：%s" % e)
        return False
    n = our_line_count(entry)
    if n != expect_ours:
        bad("回读朗读行数量 %d，期望 %d" % (n, expect_ours))
        return False
    if zusage_line_count(entry) != expect_zusage:
        bad("回读 zusage 行数量 %d，期望 %d" % (zusage_line_count(entry), expect_zusage))
        return False
    return True


# ---------------------------------------------------------------- selftest

def cmd_selftest(asar_path):
    print("[selftest] 目标:", asar_path)
    if not asar_path.is_file():
        bad("asar 不存在")
        return 1
    exe = resolve_zcode_exe(asar_path)

    order, nodes, count = flatten(asar_path)
    info("header 可解析，文件数 %d，大小 %d 字节" % (count, asar_path.stat().st_size))

    workdir = Path(tempfile.mkdtemp(prefix="readaloud-selftest-"))
    failures = 0
    try:
        # --- 1) 未改动 entry 重打 → 必须逐字节等于原包
        entry = entry_bytes_of(asar_path)
        info("入口 %s：%d 字节" % (ENTRY, len(entry)))
        same = workdir / "same.asar"
        t0 = __import__("time").time()
        repack(asar_path, {"/" + ENTRY: entry}, same)
        dt = __import__("time").time() - t0
        h_src = sha256_file(asar_path)
        h_dst = sha256_file(same)
        if h_src == h_dst:
            ok("未改动重打逐字节相同（%.2fs, sha256=%s）" % (dt, h_src[:16]))
        else:
            bad("未改动重打字节不同：%s != %s" % (h_src, h_dst))
            failures += 1

        # --- 2) 改动 entry 重打 → 只有 entry 与其后偏移变化
        delta_text = b"\n;/* readaloud selftest marker 0123456789 */"
        modified = entry + delta_text
        mod_path = workdir / "modified.asar"
        repack(asar_path, {"/" + ENTRY: modified}, mod_path)

        back = entry_bytes_of(mod_path)
        if back == modified:
            ok("改动后回读入口字节一致（+%d 字节）" % len(delta_text))
        else:
            bad("改动后回读入口字节不一致")
            failures += 1

        order2, nodes2, count2 = flatten(mod_path)
        if count2 != count:
            bad("改动后文件数变化：%d -> %d" % (count, count2))
            failures += 1

        entry_idx = next(i for i, (p, _) in enumerate(order) if p == "/" + ENTRY)
        delta = len(modified) - len(entry)
        bad_offset = []
        bad_meta = []
        for i, (p, node_old) in enumerate(order):
            node_new = nodes2.get(p)
            if node_new is None:
                bad_meta.append("%s 丢失" % p)
                continue
            if p != "/" + ENTRY:
                if node_old.get("size") != node_new.get("size"):
                    bad_meta.append("%s size 变化" % p)
                if node_old.get("integrity") != node_new.get("integrity"):
                    bad_meta.append("%s integrity 变化" % p)
            if node_old.get("unpacked") or node_new.get("unpacked"):
                continue
            off_old = int(node_old["offset"])
            off_new = int(node_new["offset"])
            if i < entry_idx:
                if off_old != off_new:
                    bad_offset.append("%s 前置偏移变化 %d->%d" % (p, off_old, off_new))
            elif i == entry_idx:
                # 入口本身位置不变（前置文件大小都没变），只是内容变长
                if off_old != off_new:
                    bad_offset.append("%s 入口偏移变化 %d->%d" % (p, off_old, off_new))
            else:
                if off_new != off_old + delta:
                    bad_offset.append("%s 后置偏移 %d->%d（期望 %d）" %
                                      (p, off_old, off_new, off_old + delta))
        if not bad_meta:
            ok("非入口文件的 size/integrity 全部未变")
        else:
            bad("非入口文件元数据变化：%s" % bad_meta[:5])
            failures += 1
        if not bad_offset:
            ok("偏移只按入口长度差 %+d 平移（前置不变，后置整体平移）" % delta)
        else:
            bad("偏移异常：%s" % bad_offset[:5])
            failures += 1

        # 内容比对：一次开文件顺序比两个 payload 区段（入口之前 / 入口之后），
        # 不做「每个文件重读一次 header」——8MB header × 数万文件会跑成小时级。
        base_old = payload_base(asar_path)
        base_new = payload_base(mod_path)
        node_entry_old = nodes["/" + ENTRY]
        node_entry_new = nodes2["/" + ENTRY]
        off_entry_old = int(node_entry_old["offset"])
        off_entry_new = int(node_entry_new["offset"])
        size_entry_old = int(node_entry_old["size"])
        size_entry_new = int(node_entry_new["size"])
        seg_before = min(off_entry_old, off_entry_new)
        tail_old = asar_path.stat().st_size - base_old - off_entry_old - size_entry_old
        tail_new = mod_path.stat().st_size - base_new - off_entry_new - size_entry_new
        before_same = compare_segment(asar_path, base_old, mod_path, base_new, seg_before)
        after_same = (tail_old == tail_new and
                      compare_segment(asar_path, base_old + off_entry_old + size_entry_old,
                                      mod_path, base_new + off_entry_new + size_entry_new,
                                      tail_old))
        if before_same and after_same:
            ok("入口前后的 payload 区段逐字节相同（非入口文件内容全等）")
        else:
            bad("payload 区段不同（前=%s 后=%s）" % (before_same, after_same))
            failures += 1

        # --- 3) 注入行逻辑（不写盘）
        new_entry, stripped, removed = build_new_entry(entry)
        try:
            validate_entry_pair(entry, new_entry, stripped)
            ok("注入行不变量通过（读盛行恰好 1 处，zusage 行数 %d 保持不变）"
               % zusage_line_count(new_entry))
        except AssertionError as e:
            bad("注入行不变量失败：%s" % e)
            failures += 1

        dup_entry = entry + OUR_LINE_B + OUR_LINE_B
        dup_new, dup_stripped, dup_removed = build_new_entry(dup_entry)
        try:
            validate_entry_pair(dup_entry, dup_new, dup_stripped)
            ok("重复行清理通过（人工塞 2 条重复 -> 清 %d 条 -> 恰好 1 条）" % dup_removed)
        except AssertionError as e:
            bad("重复行清理失败：%s" % e)
            failures += 1

        # --- 4) 注入后的入口语法
        passed, detail = syntax_check_entry(new_entry, exe)
        if passed:
            ok("注入后入口语法通过（%s）" % detail.split(": ", 1)[-1])
        elif passed is None:
            info("语法检查跳过：%s" % detail)
        else:
            bad("注入后入口语法失败：%s" % detail)
            failures += 1
    finally:
        try:
            for f in workdir.iterdir():
                f.unlink(missing_ok=True)
            workdir.rmdir()
        except OSError:
            info("临时目录未清理干净：%s" % workdir)

    print()
    if failures == 0:
        print("[selftest] PASS")
        return 0
    print("[selftest] FAIL (%d 项)" % failures)
    return 1


# ---------------------------------------------------------------- install

def cmd_install(asar_path):
    print("[install] 目标:", asar_path)
    for f, label in ((LOADER, "loader"), (RENDERER, "renderer")):
        if not f.is_file():
            bad("%s 缺失：%s" % (label, f))
            return 1
    if not asar_path.is_file():
        bad("asar 不存在")
        return 1

    # P0：运行中直接拒绝（只对现役安装；副本演练不适用）
    if not guard_client_running(asar_path, "安装"):
        return 2

    if not target_writable(asar_path):
        info("需要管理员权限，请用管理员终端重跑。")
        return 1

    try:
        old_entry = entry_bytes_of(asar_path)
    except (OSError, ValueError, KeyError, struct.error) as e:
        bad("读取入口失败：%s" % e)
        return 1

    before_ours = our_line_count(old_entry)
    before_z = zusage_line_count(old_entry)
    info("当前：朗读行 %d 条，zusage 行 %d 条" % (before_ours, before_z))

    stripped, removed = strip_ours(old_entry)
    if before_ours == 1 and OUR_LINE_B in old_entry:
        ok("已安装且注入行指向当前目录，无需重打包")
        set_pristine(asar_path, hashlib.sha256(stripped).hexdigest())
        return 0
    info("将追加注入行（剥离历史行 %d 条后重写）" % removed if removed
         else "将追加注入行")

    new_entry = stripped + OUR_LINE_B
    try:
        validate_entry_pair(old_entry, new_entry, stripped)
        ok("注入行不变量通过")
    except AssertionError as e:
        bad("注入行不变量失败：%s" % e)
        return 1

    exe = resolve_zcode_exe(asar_path)
    passed, detail = syntax_check_entry(new_entry, exe)
    if passed is False:
        bad("入口语法预检失败：%s" % detail)
        return 1
    info(detail)

    # 记录「安装前入口指纹」，remove 时用来断言字节回到原样
    if set_pristine(asar_path, hashlib.sha256(stripped).hexdigest()):
        info("已记录安装前入口指纹：%s" % PRISTINE_FILE)
    else:
        info("安装前指纹已存在，沿用（官方升级后请先 remove 再 install 以刷新）")

    stage = asar_path.with_name(STAGE_NAME)
    stage.unlink(missing_ok=True)
    info("重打包（%d 字节，流式写）..." % asar_path.stat().st_size)
    t0 = __import__("time").time()
    try:
        repack(asar_path, {"/" + ENTRY: new_entry}, stage)
    except (OSError, ValueError, KeyError, struct.error) as e:
        bad("重打包失败：%s" % e)
        stage.unlink(missing_ok=True)
        return 1
    info("重打包完成（%.2fs）" % (__import__("time").time() - t0))

    meta = {"entry": new_entry, "zusage": before_z, "exe": exe, "ours": 1}
    if not publish_stage(stage, asar_path, meta):
        stage.unlink(missing_ok=True)
        return 1
    if not verify_installed(asar_path, 1, before_z):
        return 1
    ok("已安装：朗读行 1 条，zusage 行 %d 条" % before_z)
    if removed:
        info("（顺带清理了 %d 条重复/历史行）" % removed)
    print()
    print("启动 ZCode 后每条助手回复的操作栏（复制/赞/踩/分叉/钩子）右侧会多一个 🔊 朗读按钮。")
    return 0


# ---------------------------------------------------------------- remove

def cmd_remove(asar_path):
    print("[remove] 目标:", asar_path)
    if not asar_path.is_file():
        bad("asar 不存在")
        return 1
    if not guard_client_running(asar_path, "改动 asar"):
        return 2
    if not target_writable(asar_path):
        return 1

    try:
        old_entry = entry_bytes_of(asar_path)
    except (OSError, ValueError, KeyError, struct.error) as e:
        bad("读取入口失败：%s" % e)
        return 1

    stripped, removed = strip_ours(old_entry)
    if removed == 0:
        ok("当前未注入，无需处理（只读检查通过）")
        return 0
    info("将剥离 %d 条朗读注入行（null 回退：只删自己的行，不动 zusage）" % removed)
    if zusage_line_count(stripped) != zusage_line_count(old_entry):
        bad("剥离过程中 zusage 行数发生变化，已中止")
        return 1

    stage = asar_path.with_name(STAGE_NAME)
    stage.unlink(missing_ok=True)
    info("重打包（流式写）...")
    t0 = __import__("time").time()
    try:
        repack(asar_path, {"/" + ENTRY: stripped}, stage)
    except (OSError, ValueError, KeyError, struct.error) as e:
        bad("重打包失败：%s" % e)
        stage.unlink(missing_ok=True)
        return 1
    info("重打包完成（%.2fs）" % (__import__("time").time() - t0))

    exe = resolve_zcode_exe(asar_path)
    meta = {"entry": stripped, "zusage": zusage_line_count(old_entry), "exe": exe, "ours": 0}
    if not publish_stage(stage, asar_path, meta):
        stage.unlink(missing_ok=True)
        return 1
    if not verify_installed(asar_path, 0, zusage_line_count(old_entry)):
        return 1

    # 与安装前指纹对比
    pristine = get_pristine(asar_path)
    if pristine:
        cur = hashlib.sha256(stripped).hexdigest()
        if cur == pristine:
            ok("剥离后入口字节与安装前完全一致（sha256=%s）" % cur[:16])
        else:
            info("剥离后入口 sha256=%s，安装前=%s（asar 已被官方升级，属正常）"
                 % (cur[:16], pristine[:16]))
    ok("已剥离朗读注入行（zusage 行 %d 条保留）" % zusage_line_count(old_entry))
    print()
    print("重启 ZCode 后生效。")
    return 0


# ---------------------------------------------------------------- check

def cmd_check(asar_path):
    print("[check] asar:", asar_path, asar_path.stat().st_size if asar_path.is_file() else "-", "字节")
    if not asar_path.is_file():
        bad("asar 不存在")
        return 1
    failures = 0
    try:
        order, nodes, count = flatten(asar_path)
        ok("header 可解析，文件数 %d" % count)
    except (OSError, ValueError, KeyError, struct.error) as e:
        bad("header 解析失败：%s" % e)
        return 1

    try:
        entry = entry_bytes_of(asar_path)
    except (OSError, ValueError, KeyError, struct.error) as e:
        bad("读取入口失败：%s" % e)
        return 1

    n = our_line_count(entry)
    z = zusage_line_count(entry)
    if n == 1:
        ok("朗读注入行：恰好 1 条")
    elif n == 0:
        info("朗读注入行：未注入")
    else:
        bad("朗读注入行：%d 条（重复，请重跑 install 清理）" % n)
        failures += 1

    if z >= 1:
        ok("zusage 注入行：%d 条（未受影响）" % z)
    else:
        info("zusage 注入行：未检测到")

    if OUR_LINE_B in entry and n == 1:
        ok("注入行指向当前目录：%s" % LOADER.as_uri())
    elif n == 1:
        stray = OUR_RE.findall(entry)
        info("注入了，但指向别的目录：%s" % (stray[0][:120] if stray else "?"))

    exe = resolve_zcode_exe(asar_path)
    passed, detail = syntax_check_entry(entry, exe)
    if passed:
        ok("入口语法通过（%s）" % detail.split(": ", 1)[-1])
    elif passed is None:
        info("入口语法检查跳过：%s" % detail)
    else:
        bad("入口语法失败：%s" % detail)
        failures += 1

    stage = asar_path.with_name(STAGE_NAME)
    if stage.exists():
        info("发现残留 stage 文件（不会被自动应用，可手动删除）：%s" % stage)

    pristine = get_pristine(asar_path)
    if pristine:
        cur = hashlib.sha256(entry).hexdigest()
        info("安装前入口指纹 %s / 当前 %s%s" %
             (pristine[:16], cur[:16],
              "（未注入且相等 = 与安装前一致）" if n == 0 and cur == pristine else ""))

    print()
    if failures:
        print("[check] FAIL (%d 项)" % failures)
        return 1
    if n == 0:
        # 未注入 = 功能不存在（多半是官方升级整包替换了 asar），不能报 PASS/退 0
        print("[check] NOT-INSTALLED（未注入朗读行；需要时重跑 install）")
        return 3
    print("[check] PASS")
    return 0


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser(description="ZCode app.asar 朗读按钮注入工具")
    ap.add_argument("command", choices=["selftest", "install", "remove", "check"])
    ap.add_argument("--asar", default=None,
                    help="app.asar 完整路径（默认先查环境变量 READALOUD_ASAR，"
                         "最后兜底 D:\\ZCode\\resources\\app.asar）")
    args = ap.parse_args(argv)

    asar_path = resolve_asar(args.asar)
    if args.command == "selftest":
        return cmd_selftest(asar_path)
    if args.command == "install":
        return cmd_install(asar_path)
    if args.command == "remove":
        return cmd_remove(asar_path)
    return cmd_check(asar_path)


if __name__ == "__main__":
    sys.exit(main())

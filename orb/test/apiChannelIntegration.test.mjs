/* 开关的跨重启集成测试：provider + apiChannel + 真实文件。
 * 这一段是桥里实际接线方式的镜像（load/save 都走 JSON 文件），
 * 专门验证「拨了之后重启桥还在不在」——单测用内存 fake 覆盖不到这一层。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiChannel } from "../apiChannel.mjs";
import { createBrowserProvider } from "../browserProvider.mjs";

const HELLO = { type: "provider_hello", protocol: 1, extension_id: "ext", extension_version: "1.0.0", browser_family: "chrome" };

function wire(file) {
  const apiChannel = createApiChannel({
    load: () => {
      try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
    },
    save: (s) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", "utf8");
        fs.renameSync(tmp, file);
        return { ok: true };
      } catch (e) { return { ok: false, warning: String(e && e.message) }; }
    },
  });
  const provider = createBrowserProvider({
    settingsSnapshot: () => ({ api_channel_enabled: apiChannel.isEnabled() }),
    onSettings: ({ api_channel_enabled }) => apiChannel.setEnabled(api_channel_enabled, { by: "popup" }),
  });
  return { apiChannel, provider };
}

/* 必须 await：直接 return 时 fn 还是个未完成的 Promise，
 * finally 会先删掉临时目录，后面的读写才报 ENOENT（看起来像被测代码坏了）。 */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-apich-"));
  try { return await fn(path.join(dir, "api-channel.json"), dir); }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

test("首次握手：桥没有记录时回报关，且不凭空写文件", () => {
  withTempDir((file) => {
    const { apiChannel, provider } = wire(file);
    return provider.handle({ ...HELLO }).then((ack) => {
      assert.equal(ack.api_channel_enabled, false);
      assert.equal(apiChannel.isEnabled(), false);
      assert.equal(fs.existsSync(file), false, "只读状态下不该落盘");
    });
  });
});

test("面板开启后写盘，重启（新实例）仍然是开", () => {
  withTempDir((file) => {
    const first = wire(file);
    return first.provider.handle({ type: "settings", api_channel_enabled: true })
      .then((ack) => {
        assert.equal(ack.accepted, true);
        assert.equal(ack.persisted, true);
        assert.equal(ack.api_channel_enabled, true);
        const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.equal(onDisk.enabled, true);
        assert.equal(onDisk.updatedBy, "popup");

        /* 模拟桥重启：新实例从同一份文件读 */
        const second = wire(file);
        assert.equal(second.apiChannel.isEnabled(), true);
        return second.provider.handle({ ...HELLO });
      })
      .then((ack) => assert.equal(ack.api_channel_enabled, true, "重启后握手要回报开"));
  });
});

test("关闭回到关，并且文件同步为关", () => {
  withTempDir((file) => {
    const { provider } = wire(file);
    return provider.handle({ type: "settings", api_channel_enabled: true })
      .then(() => provider.handle({ type: "settings", api_channel_enabled: false }))
      .then((ack) => {
        assert.equal(ack.api_channel_enabled, false);
        assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).enabled, false);
      });
  });
});

test("磁盘文件损坏：退回关，握手不谎报开", () => {
  withTempDir((file, dir) => {
    fs.writeFileSync(file, "{ not json", "utf8");
    const { apiChannel, provider } = wire(file);
    assert.equal(apiChannel.isEnabled(), false);
    return provider.handle({ ...HELLO }).then((ack) => assert.equal(ack.api_channel_enabled, false));
  });
});

test("文件被手改成 enabled:\"true\"（字符串）也还是关", () => {
  withTempDir((file) => {
    fs.writeFileSync(file, JSON.stringify({ enabled: "true" }), "utf8");
    const { apiChannel } = wire(file);
    assert.equal(apiChannel.isEnabled(), false);
  });
});

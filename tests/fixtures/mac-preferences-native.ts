/** Disposable, uniquely identified packaged host: no Synora data or model. */
import { app, Notification } from "electron";
import { writeFileSync } from "node:fs";
import {
  loginItemHook,
  lifecycleContent,
} from "../../src/main/native-preferences";
declare const SYNORA_PREFERENCE_QA: { root: string; name: string };
const config = SYNORA_PREFERENCE_QA;
app.setName(config.name);
app.setPath("userData", config.root + "/profile");
app
  .whenReady()
  .then(async () => {
    const report: Record<string, unknown> = {
      scope:
        "Disposable macOS login-item read/write/restore and notification delivery; no account or inference",
      time: new Date().toISOString(),
      packaged: app.isPackaged,
    };
    const hook = loginItemHook(app, "darwin", process.execPath);
    const original = hook.read();
    report.originalLogin = original;
    try {
      hook.write(true);
      report.enabledLogin = hook.read();
    } catch (e) {
      report.loginError = (e as Error).message;
      report.loginStatus = app.getLoginItemSettings().status;
    } finally {
      try {
        hook.write(original);
        report.restoredLogin = hook.read() === original;
      } catch (e) {
        report.restoreError = (e as Error).message;
      }
    }
    report.notificationsSupported = Notification.isSupported();
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: "Synora settings verification",
        body: lifecycleContent.recovered.body,
        silent: true,
      });
      report.notification = await new Promise<string>((resolve) => {
        const deadline = setTimeout(() => resolve("not-confirmed"), 6000);
        const done = (v: string) => {
          clearTimeout(deadline);
          resolve(v);
        };
        notification.on("show", () => done("shown"));
        notification.on("failed", (_, error) => done("failed: " + error));
        notification.show();
      });
      notification.close();
    }
    writeFileSync(
      config.root + "/native-report.json",
      JSON.stringify(report, null, 2),
    );
    app.exit(report.restoredLogin ? 0 : 1);
  })
  .catch((e) => {
    writeFileSync(
      config.root + "/native-report.json",
      JSON.stringify({ error: e.message }),
    );
    app.exit(1);
  });

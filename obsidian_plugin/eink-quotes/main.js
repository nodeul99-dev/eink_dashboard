/*
 * DS_CRO 대시보드 인용구 — 옵시디언 플러그인 (PC·아이폰 공용, 빌드 없이 쓰는 단일 파일)
 *
 * Books 폴더의 독서 노트를 묶어 Apps Script 웹앱(doPost)으로 보낸다.
 * Apps Script 가 인용구만 뽑아 구글 드라이브에 저장하고, Poke3 는 동기화할 때 그걸 받아 간다.
 * PC 와 Poke3 는 직접 연결되지 않는다. 드라이브가 우편함 역할을 한다.
 *
 * 보내는 때
 *   - 옵시디언을 켤 때 한 번
 *   - Books 안의 노트를 저장·추가·삭제·이름변경 했을 때 (마지막 변경 후 1분 뒤 한 번)
 *   - 명령 팔레트 → "인용구 지금 보내기"
 *   내용이 지난번에 보낸 것과 같으면 보내지 않는다.
 *
 * Obsidian Sync 로 플러그인·설정(data.json)이 모든 기기에 퍼진다. 어느 기기에서 노트를 고치든
 * 그 기기가 보낸다. lastHash 도 함께 동기화되므로 같은 내용을 여러 기기가 중복으로 보내지 않는다.
 * 자동 전송 실패(오프라인·차단된 망)는 조용히 기록만 하고, 알림은 직접 보낼 때만 띄운다.
 */
'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');

const DEFAULTS = {
  webAppUrl: '',
  token: '',
  folder: 'Books',
  autoSend: true,
  lastHash: '',
  lastSentAt: '',
  lastResult: '',
};

const DEBOUNCE_MS = 60 * 1000;

// 문자열 해시 (내용이 바뀌었는지만 보면 되므로 가벼운 것으로)
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16) + ':' + s.length;
}

function nowText() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

module.exports = class EinkQuotesPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.timer = null;
    this.sending = false;

    this.addSettingTab(new EinkQuotesSettingTab(this.app, this));

    this.addCommand({
      id: 'send-now',
      name: '인용구 지금 보내기',
      callback: () => this.send({ manual: true, force: true }),
    });

    // Books 폴더 안의 변화만 본다
    const onChange = (file) => {
      if (file && this.inFolder(file.path)) this.schedule();
    };
    const onRename = (file, oldPath) => {
      if ((file && this.inFolder(file.path)) || this.inFolder(oldPath)) this.schedule();
    };

    // 볼트를 다 읽은 뒤에 이벤트를 걸어야 시작할 때 쏟아지는 create 이벤트를 피한다
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('modify', onChange));
      this.registerEvent(this.app.vault.on('create', onChange));
      this.registerEvent(this.app.vault.on('delete', onChange));
      this.registerEvent(this.app.vault.on('rename', onRename));
      if (this.settings.autoSend) this.send({ manual: false });
    });
  }

  onunload() {
    if (this.timer) clearTimeout(this.timer);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  folderPrefix() {
    return this.settings.folder.replace(/^\/+|\/+$/g, '') + '/';
  }

  inFolder(path) {
    return !!path && path.toLowerCase().startsWith(this.folderPrefix().toLowerCase()) && /\.md$/i.test(path);
  }

  schedule() {
    if (!this.settings.autoSend) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send({ manual: false });
    }, DEBOUNCE_MS);
  }

  /** Books 폴더의 노트를 "@@@FILE@@@ 파일명" 구분자로 묶는다 (Apps Script splitBundle_ 형식) */
  async buildBundle() {
    const files = this.app.vault.getMarkdownFiles()
      .filter((f) => this.inFolder(f.path))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    const parts = [];
    for (const f of files) {
      const text = await this.app.vault.cachedRead(f);
      parts.push('@@@FILE@@@ ' + f.name + '\n' + text);
    }
    return { count: files.length, bundle: parts.join('\n') };
  }

  async send({ manual, force }) {
    const s = this.settings;
    if (!s.webAppUrl || !s.token) {
      if (manual) new Notice('대시보드 인용구: 설정에서 웹 앱 URL과 TOKEN을 먼저 넣어 주세요');
      return;
    }
    if (this.sending) return;
    this.sending = true;
    try {
      const { count, bundle } = await this.buildBundle();
      if (!count) {
        if (manual) new Notice(`대시보드 인용구: '${s.folder}' 폴더에 노트가 없습니다`);
        return;
      }
      const h = hash(bundle);
      if (!force && h === s.lastHash) return;   // 바뀐 게 없으면 보내지 않는다

      const res = await requestUrl({
        url: s.webAppUrl,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ token: s.token, bundle: bundle }),
        throw: false,
      });
      let body = null;
      try { body = res.json; } catch (e) { body = null; }

      if (res.status >= 200 && res.status < 300 && body && body.ok) {
        s.lastHash = h;
        s.lastSentAt = nowText();
        s.lastResult = `노트 ${body.files}개 → 인용구 ${body.quotes}개` + (body.skipped_long ? ` (긴 것 ${body.skipped_long}개 제외)` : '');
        await this.saveSettings();
        if (manual) new Notice('대시보드 인용구: ' + s.lastResult);
      } else {
        const why = body && body.error ? body.error : 'HTTP ' + res.status;
        s.lastResult = '실패: ' + why;
        await this.saveSettings();
        if (manual) new Notice('대시보드 인용구 보내기 실패: ' + why);
      }
    } catch (e) {
      // 오프라인 등. 다음 변경이나 다음 실행 때 다시 시도된다
      this.settings.lastResult = '실패: ' + (e && e.message ? e.message : e);
      await this.saveSettings();
      if (manual) new Notice('대시보드 인용구 보내기 ' + this.settings.lastResult);
    } finally {
      this.sending = false;
    }
  }
};

class EinkQuotesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName('웹 앱 URL')
      .setDesc('Apps Script 배포 URL (…/exec 로 끝남). ?token= 은 붙이지 않는다')
      .addText((t) => t
        .setPlaceholder('https://script.google.com/macros/s/.../exec')
        .setValue(s.webAppUrl)
        .onChange(async (v) => {
          // ?token=... 까지 통째로 붙여 넣어도 알아서 나눈다
          const m = v.trim().match(/^(https:\/\/script\.google\.com\/macros\/s\/[^/?\s]+\/exec)(?:\?token=\s*(\S+))?/);
          s.webAppUrl = m ? m[1] : v.trim();
          if (m && m[2]) s.token = m[2];
          s.lastHash = '';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('TOKEN')
      .setDesc('Apps Script 스크립트 속성의 TOKEN')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setValue(s.token).onChange(async (v) => {
          s.token = v.trim();
          s.lastHash = '';
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('독서 노트 폴더')
      .setDesc('볼트 안 경로. 하위 폴더의 노트도 포함한다')
      .addText((t) => t.setValue(s.folder).onChange(async (v) => {
        s.folder = v.trim() || 'Books';
        s.lastHash = '';
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('자동으로 보내기')
      .setDesc('옵시디언을 켤 때, 독서 노트를 고친 뒤 1분이 지나면 보낸다')
      .addToggle((t) => t.setValue(s.autoSend).onChange(async (v) => {
        s.autoSend = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('지금 보내기')
      .setDesc(s.lastSentAt ? `마지막 전송 ${s.lastSentAt} · ${s.lastResult}` : (s.lastResult || '아직 보낸 적 없음'))
      .addButton((b) => b.setButtonText('보내기').setCta().onClick(async () => {
        await this.plugin.send({ manual: true, force: true });
        this.display();
      }));
  }
}

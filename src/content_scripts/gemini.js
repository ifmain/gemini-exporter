/**
 * Gemini Chat Exporter (Clean UI, Square Images, Base64 - Fixed Array Index Bug)
 */

(function() {
  'use strict';

  const CONFIG = {
    CONTAINER_ID: 'gemini-export-widget',
    SELECTORS: {
      CHAT_CONTAINER: '[data-test-id="chat-history-container"]',
      CONVERSATION_TURN: 'div.conversation-container',
      USER_QUERY_TEXT: '.query-text .query-text-line',
      MODEL_RESPONSE_CONTENT: 'message-content .markdown'
    },
    TIMING: {
      SCROLL_DELAY: 2000,
      POPUP_DURATION: 1500,
      MAX_SCROLL_ATTEMPTS: 60,
      MAX_STABLE_SCROLLS: 4
    },
    MATH_BLOCK_SELECTOR: '.math-block[data-math]',
    MATH_INLINE_SELECTOR: '.math-inline[data-math]'
  };

  class DateUtils {
    static getDateString() {
      const d = new Date();
      const pad = n => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }
  }

  class StringUtils {
    static sanitizeFilename(text) {
      return text.replace(/[\\/:*?"<>|.]/g, '').replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
    }
    static removeCitations(text) {
      return text.replace(/\[cite_start\]/g, '').replace(/\+\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  class DOMUtils {
    static sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    static createNotification(message) {
      const popup = document.createElement('div');
      Object.assign(popup.style, {
        position: 'fixed', top: '24px', right: '24px', zIndex: '99999',
        background: '#333', color: '#fff', padding: '10px 18px',
        borderRadius: '8px', fontSize: '1em', boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
        opacity: '0.95', pointerEvents: 'none'
      });
      popup.textContent = message;
      document.body.appendChild(popup);
      setTimeout(() => popup.remove(), CONFIG.TIMING.POPUP_DURATION);
    }
    
    static isVisible(element) {
      return element && element.getBoundingClientRect().height > 0;
    }

    static getTitle() {
      const activeChat = document.querySelector('a[aria-current="true"] .conversation-title');
      if (activeChat) return activeChat.textContent.trim();
      return document.title.replace(/\s*-\s*Gemini$/i, '').trim() || 'Gemini_Chat';
    }

    static async getBase64FromImage(imgElement) {
      const src = imgElement.src;
      if (!src) return null;
      if (src.startsWith('data:')) return src;

      if (src.startsWith('blob:')) {
        try {
          const res = await fetch(src);
          const blob = await res.blob();
          return await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        } catch (e) {
          return src;
        }
      }

      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'fetchImage', url: src }, (response) => {
          if (chrome.runtime.lastError || !response || response.error) {
            resolve(src); 
          } else {
            resolve(response.base64);
          }
        });
      });
    }

    static async processNodeImages(clonedNode) {
      const imgs = Array.from(clonedNode.querySelectorAll('img'));
      const base64Images = [];
      
      for (let img of imgs) {
        if (img.classList.contains('user-icon') || img.src.includes('avatar') || img.src.includes('spark')) {
          img.remove();
          continue;
        }

        const b64 = await this.getBase64FromImage(img);
        if (b64) {
          img.src = b64;
          img.removeAttribute('srcset'); 
          img.removeAttribute('loading'); 
          if (b64.startsWith('data:')) {
            base64Images.push(b64);
          }
        }
      }
      return base64Images;
    }

    
    static sanitizeNode(node) {
      const junkSelectors = [
        'message-actions', 
        '.generated-image-controls', 
        '.conversation-actions-container',
        'share-button',
        'copy-button',
        'thumb-up-button',
        'thumb-down-button',
        'regenerate-button',
        'bot-actions-menu',
        'tts-control',
        '.action-button'
      ];
      node.querySelectorAll(junkSelectors.join(', ')).forEach(el => el.remove());
    }
  }

  class DataExtractor {
    constructor() {
      this.turndown = this._initTurndown();
    }

    _initTurndown() {
      if (typeof window.TurndownService !== 'function') return null;
      const td = new window.TurndownService({
        codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**',
        headingStyle: 'atx', hr: '---', bulletListMarker: '-', codeBlockFence: '```'
      });
      td.addRule('mathBlock', {
        filter: n => n.nodeType === 1 && n.matches?.(CONFIG.MATH_BLOCK_SELECTOR),
        replacement: (c, n) => `$$${n.getAttribute('data-math') || ''}$$\n\n`
      });
      td.addRule('mathInline', {
        filter: n => n.nodeType === 1 && n.matches?.(CONFIG.MATH_INLINE_SELECTOR),
        replacement: (c, n) => `$${n.getAttribute('data-math') || ''}$`
      });
      return td;
    }

    async extractUser(turn) {
      const userContent = turn.querySelector('user-query');
      if (!userContent) return { text: '', images: [] };

      const cloned = userContent.cloneNode(true);
      DOMUtils.sanitizeNode(cloned);
      
      const images = await DOMUtils.processNodeImages(cloned);
      
      const lines = Array.from(cloned.querySelectorAll(CONFIG.SELECTORS.USER_QUERY_TEXT))
        .map(el => el.textContent.trim()).filter(t => t.length > 0);
      const text = lines.length ? lines.join('\n') : (cloned.querySelector('.query-text')?.textContent.trim() || '');

      return { text, images };
    }

    async extractModel(turn) {
      const contentEl = turn.querySelector(CONFIG.SELECTORS.MODEL_RESPONSE_CONTENT);
      if (!contentEl) return { text: '', html: '', images: [] };
      
      const cloned = contentEl.cloneNode(true);
      DOMUtils.sanitizeNode(cloned);

      const images = await DOMUtils.processNodeImages(cloned);
      
      const rawHtml = cloned.innerHTML;
      const markdown = this.turndown ? this.turndown.turndown(rawHtml) : cloned.textContent;
      
      return {
        text: StringUtils.removeCitations(markdown),
        html: rawHtml,
        images: images
      };
    }
  }

  class ExportFormatters {
    static async generateMD(turns, title, extractor) {
      let md = `# ${title}\n> Exported on: ${new Date().toLocaleString()}\n\n---\n\n`;
      
      for (let i = 0; i < turns.length; i++) {
        DOMUtils.createNotification(`Processing message ${i + 1}/${turns.length}...`);
        
        const user = await extractor.extractUser(turns[i]);
        if (user.text || user.images.length) {
          md += `## You\n\n${user.text}\n\n`;
          user.images.forEach((b64, idx) => md += `![User Upload ${idx + 1}](${b64})\n\n`);
        }

        const model = await extractor.extractModel(turns[i]);
        if (model.text) {
          md += `## Gemini\n\n${model.text}\n\n`;
        }
        md += '---\n\n';
      }
      return md;
    }

    static async generateJSON(turns, title, extractor) {
      const json = {
        title: title,
        messages: []
      };

      for (let i = 0; i < turns.length; i++) {
        DOMUtils.createNotification(`Processing message ${i + 1}/${turns.length}...`);
        
        const user = await extractor.extractUser(turns[i]);
        if (user.text || user.images.length) {
          const content = [];
          if (user.text) content.push({ type: "text", text: user.text });
          user.images.forEach(b64 => content.push({ type: "image", image_url: b64 }));
          json.messages.push({ role: "user", content: content });
        }

        const model = await extractor.extractModel(turns[i]);
        if (model.text || model.images.length) {
          const content = [];
          if (model.text) content.push({ type: "text", text: model.text });
          model.images.forEach(b64 => content.push({ type: "image", image_url: b64 }));
          json.messages.push({ role: "assistant", content: content });
        }
      }
      return JSON.stringify(json, null, 2);
    }

    static async generateHTML(turns, title, extractor) {
      let bodyHtml = '';
      
      for (let i = 0; i < turns.length; i++) {
        DOMUtils.createNotification(`Processing message ${i + 1}/${turns.length}...`);
        
        const user = await extractor.extractUser(turns[i]);
        if (user.text || user.images.length) {
          bodyHtml += `<div class="message user"><h3>You</h3><p>${user.text.replace(/\n/g, '<br>')}</p>`;
          if (user.images.length > 0) {
            bodyHtml += `<div class="image-gallery">`;
            user.images.forEach(b64 => {
               bodyHtml += `<img src="${b64}" alt="User Image">`;
            });
            bodyHtml += `</div>`;
          }
          bodyHtml += `</div>`;
        }

        const model = await extractor.extractModel(turns[i]);
        if (model.html) {
          bodyHtml += `<div class="message assistant"><h3>Gemini</h3><div class="model-content">${model.html}</div></div>`;
        }
      }

      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f9f9f9; color: #333; }
  .message { background: #fff; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  .user { border-left: 4px solid #1a73e8; }
  .assistant { border-left: 4px solid #34a853; }
  h3 { margin-top: 0; font-size: 1.1em; color: #555; }
  pre { background: #f1f3f4; padding: 10px; border-radius: 4px; overflow-x: auto; }
  code { font-family: monospace; }
  
  .image-gallery, .model-content { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
  .model-content { flex-direction: column; }
  .message img { 
    width: 200px; 
    height: 200px; 
    object-fit: cover; 
    border-radius: 8px; 
    border: 1px solid #ddd;
    background-color: #f1f3f4;
  }
  .model-content img { display: inline-block; }
</style>
</head>
<body>
  <h1>${title}</h1>
  ${bodyHtml}
</body>
</html>`;
    }
  }

  class ExportController {
    constructor() {
      this.extractor = new DataExtractor();
    }

    init() {
      if (document.getElementById(CONFIG.CONTAINER_ID)) return;

      const container = document.createElement('div');
      container.id = CONFIG.CONTAINER_ID;
      Object.assign(container.style, {
        position: 'fixed', top: '80px', right: '20px', zIndex: '9999',
        display: 'flex', flexDirection: 'column', gap: '5px'
      });

      const mainBtn = document.createElement('button');
      mainBtn.textContent = 'Export Chat ▾';
      Object.assign(mainBtn.style, this._getBtnStyles(true));

      const menu = document.createElement('div');
      Object.assign(menu.style, {
        display: 'none', flexDirection: 'column', gap: '5px',
        backgroundColor: '#fff', padding: '5px', borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)', border: '1px solid #ddd'
      });

      const formats = [
        { id: 'md', label: 'Markdown (.md)', ext: 'md', mime: 'text/markdown' },
        { id: 'json', label: 'JSON Format', ext: 'json', mime: 'application/json' },
        { id: 'html', label: 'HTML Page', ext: 'html', mime: 'text/html' }
      ];

      formats.forEach(f => {
        const btn = document.createElement('button');
        btn.textContent = f.label;
        Object.assign(btn.style, this._getBtnStyles(false));
        btn.addEventListener('mouseenter', () => btn.style.background = '#f1f3f4');
        btn.addEventListener('mouseleave', () => btn.style.background = 'transparent');
        btn.addEventListener('click', () => this._handleExport(f, mainBtn, menu));
        menu.appendChild(btn);
      });

      mainBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
      });

      document.addEventListener('click', () => menu.style.display = 'none');

      container.appendChild(mainBtn);
      container.appendChild(menu);
      document.body.appendChild(container);
    }

    _getBtnStyles(isMain) {
      if (isMain) {
        return {
          padding: '10px 20px', background: '#1a73e8', color: '#fff', border: 'none',
          borderRadius: '8px', fontSize: '1em', cursor: 'pointer', fontWeight: 'bold',
          boxShadow: '0 2px 6px rgba(0,0,0,0.2)'
        };
      }
      return {
        padding: '8px 12px', background: 'transparent', color: '#333', border: 'none',
        borderRadius: '4px', fontSize: '0.95em', cursor: 'pointer', textAlign: 'left',
        width: '100%'
      };
    }

    async _handleExport(formatInfo, mainBtn, menu) {
      menu.style.display = 'none';
      mainBtn.disabled = true;
      mainBtn.textContent = 'Exporting...';

      try {
        await this._scrollToBottom();
        
        const turns = Array.from(document.querySelectorAll(CONFIG.SELECTORS.CONVERSATION_TURN))
                           .filter(DOMUtils.isVisible);

        if (turns.length === 0) throw new Error('No visible messages found.');

        const title = DOMUtils.getTitle();
        const filename = `${StringUtils.sanitizeFilename(title)}_${DateUtils.getDateString()}.${formatInfo.ext}`;

        let outputData = '';
        if (formatInfo.id === 'md') outputData = await ExportFormatters.generateMD(turns, title, this.extractor);
        if (formatInfo.id === 'json') outputData = await ExportFormatters.generateJSON(turns, title, this.extractor);
        if (formatInfo.id === 'html') outputData = await ExportFormatters.generateHTML(turns, title, this.extractor);

        this._downloadFile(outputData, filename, formatInfo.mime);
      } catch (e) {
        console.error('Export Error:', e);
        alert(`Export failed: ${e.message}`);
      } finally {
        mainBtn.disabled = false;
        mainBtn.textContent = 'Export Chat ▾';
      }
    }

    async _scrollToBottom() {
      const scrollContainer = document.querySelector(CONFIG.SELECTORS.CHAT_CONTAINER);
      if (!scrollContainer) return;
      
      let stableScrolls = 0, scrollAttempts = 0, lastScrollTop = null;
      while (stableScrolls < CONFIG.TIMING.MAX_STABLE_SCROLLS && scrollAttempts < CONFIG.TIMING.MAX_SCROLL_ATTEMPTS) {
        scrollContainer.scrollTop = 0;
        await DOMUtils.sleep(CONFIG.TIMING.SCROLL_DELAY);
        
        if (lastScrollTop === scrollContainer.scrollTop || scrollContainer.scrollTop === 0) stableScrolls++;
        else stableScrolls = 0;
        
        lastScrollTop = scrollContainer.scrollTop;
        scrollAttempts++;
      }
    }

    _downloadFile(content, filename, mimeType) {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    }
  }

  new ExportController().init();
})();
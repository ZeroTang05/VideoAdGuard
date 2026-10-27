// ==UserScript==
// @name         B站视频植入广告检测器 VideoAdGuard
// @version      1.1.2
// @author       ZeroTang05
// @namespace    https://github.com/ZeroTang05/
// @license      GPLv2
// @description  基于大语言模型检测B站视频中的植入广告
// @icon         data:image/png;base64,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
// @homepage     https://github.com/ZeroTang05/VideoAdGuard
// @supportURL   https://github.com/ZeroTang05/VideoAdGuard/issues
// @match        *://*.bilibili.com/video/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      open.bigmodel.cn
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      *.volces.com
// @connect      dashscope.aliyuncs.com
// @connect      api.anthropic.com
// @connect      generativelanguage.googleapis.com
// @connect      api.siliconflow.cn
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // 存储设置的默认值
    const DEFAULT_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    const DEFAULT_MODEL = 'glm-4-flash';
    
    // 工具类 - WBI 签名
    const WbiUtils = {
        mixinKeyEncTab: [
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
            33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
            61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
            36, 20, 34, 44, 52
        ],
        
        getMixinKey(orig) {
            return this.mixinKeyEncTab
                .map(i => orig[i])
                .join('')
                .slice(0, 32);
        },
        
        // 简化版的 MD5 函数 (需要外部库支持)
        md5(text) {
            // 简单实现，实际使用时可能需要引入外部库
            let hash = 0;
            for (let i = 0; i < text.length; i++) {
                hash = ((hash << 5) - hash) + text.charCodeAt(i);
                hash |= 0;
            }
            return hash.toString(16);
        },
        
        async getWbiKeys() {
            const wbiCache = GM_getValue('wbi_cache');
            const today = new Date().setHours(0, 0, 0, 0);
            
            if (wbiCache && wbiCache.timestamp >= today) {
                return [wbiCache.img_key, wbiCache.sub_key];
            }
            
            try {
                const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    },
                    credentials: 'include'
                });
                
                const data = await response.json();
                if (data.code !== 0) {
                    throw new Error(data.message);
                }
                
                const imgUrl = data.data.wbi_img.img_url;
                const subUrl = data.data.wbi_img.sub_url;
                
                const imgKey = imgUrl.substring(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.'));
                const subKey = subUrl.substring(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.'));
                
                const cache = {
                    img_key: imgKey,
                    sub_key: subKey,
                    timestamp: today
                };
                
                GM_setValue('wbi_cache', cache);
                return [imgKey, subKey];
            } catch (error) {
                console.error('【VideoAdGuard】获取WBI密钥失败:', error);
                throw error;
            }
        },
        
        async encWbi(params) {
            const [imgKey, subKey] = await this.getWbiKeys();
            const mixinKey = this.getMixinKey(imgKey + subKey);
            const currTime = Math.floor(Date.now() / 1000);
            
            const newParams = {
                ...params,
                wts: currTime
            };
            
            // 按照key排序
            const query = Object.keys(newParams)
                .sort()
                .map(key => {
                    // 过滤特殊字符
                    const value = newParams[key].toString()
                        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
                        .replace(/[&?:\/=]/g, '');
                    return `${key}=${encodeURIComponent(value)}`;
                })
                .join('&');
            
            const wbiSign = this.md5(query + mixinKey);
            return {
                ...newParams,
                w_rid: wbiSign
            };
        }
    };
    
    // B站服务类
    const BilibiliService = {
        async fetchWithCookie(url, params = {}) {
            const queryString = new URLSearchParams(params).toString();
            const fullUrl = `${url}?${queryString}`;
            console.log('【VideoAdGuard】[BilibiliService] Fetching URL:', fullUrl);
            
            try {
                const response = await fetch(fullUrl, {
                    method: 'GET',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://www.bilibili.com/'
                    },
                    credentials: 'include'
                });
                
                const data = await response.json();
                console.log('【VideoAdGuard】[BilibiliService] Response data:', data);
                
                if (data.code !== 0) {
                    throw new Error(data.message);
                }
                
                return data.data;
            } catch (error) {
                console.error('【VideoAdGuard】请求失败:', error);
                throw error;
            }
        },
        
        async getVideoInfo(bvid) {
            console.log('【VideoAdGuard】[BilibiliService] Getting video info for bvid:', bvid);
            const data = await this.fetchWithCookie(
                'https://api.bilibili.com/x/web-interface/view',
                { bvid }
            );
            console.log('【VideoAdGuard】[BilibiliService] Video info result:', data);
            return data;
        },
        
        async getComments(bvid) {
            console.log('【VideoAdGuard】[BilibiliService] Getting comments for bvid:', bvid);
            const data = await this.fetchWithCookie(
                'https://api.bilibili.com/x/v2/reply',
                { oid: bvid, type: 1 }
            );
            console.log('【VideoAdGuard】[BilibiliService] Comments result:', data);
            return data;
        },
        
        async getPlayerInfo(bvid, cid) {
            console.log('【VideoAdGuard】[BilibiliService] Getting player info for bvid:', bvid, 'cid:', cid);
            const params = { bvid, cid };
            const signedParams = await WbiUtils.encWbi(params);
            const data = await this.fetchWithCookie(
                'https://api.bilibili.com/x/player/wbi/v2',
                signedParams
            );
            console.log('【VideoAdGuard】[BilibiliService] Player info result:', data);
            return data;
        },
        
        async getCaptions(url) {
            console.log('【VideoAdGuard】[BilibiliService] Getting captions from URL:', url);
            try {
                const response = await fetch(url);
                const data = await response.json();
                console.log('【VideoAdGuard】[BilibiliService] Captions result:', data);
                return data;
            } catch (error) {
                console.error('【VideoAdGuard】获取字幕失败:', error);
                throw error;
            }
        }
    };
    
    // AI 服务类
    const AIService = {
        // 添加通用请求方法
        async makeRequest(videoInfo, config) {
            console.log('【VideoAdGuard】准备向大模型发送请求');
            
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: this.getApiUrl(),
                    headers: config.headers,
                    data: JSON.stringify({
                        model: this.getModel(),
                        messages: [
                            {
                                'role': 'system',
                                'content': '你是一个敏感的视频观看者，能根据视频的连贯性改变和宣传推销类内容，找出视频中可能存在的植入广告。内容如果和主题相关，即使是推荐/评价也可能只是分享而不是广告，重点要看有没有提到通过视频博主可以受益的渠道进行购买。'
                            },
                            {
                                'role': 'user',
                                'content': this.buildPrompt(videoInfo)
                            }
                        ],
                        temperature: 0.1,
                        max_tokens: 1024,
                        ...config.bodyExtra
                    }),
                    onload: function(response) {
                        if (response.status >= 200 && response.status < 300) {
                            try {
                                const data = JSON.parse(response.responseText);
                                console.log('【VideoAdGuard】收到大模型响应:', data);
                                resolve(data);
                            } catch (error) {
                                console.error('【VideoAdGuard】解析大模型响应失败:', error);
                                reject(error);
                            }
                        } else {
                            console.error('【VideoAdGuard】请求大模型失败:', response.statusText);
                            reject(new Error('请求失败: ' + response.statusText));
                        }
                    },
                    onerror: function(error) {
                        console.error('【VideoAdGuard】请求大模型错误:', error);
                        reject(error);
                    }
                });
            });
        },
        
        async analyze(videoInfo) {
            console.log('【VideoAdGuard】开始分析视频信息:', videoInfo);
            const enableLocalOllama = this.getEnableLocalOllama();
            
            try {
                if (enableLocalOllama) {
                    console.log('【VideoAdGuard】使用本地Ollama模式');
                    const data = await this.makeRequest(videoInfo, {
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        bodyExtra: {
                            format: "json",
                            stream: false
                        }
                    });
                    return JSON.parse(data.message.content);
                } else {
                    const apiKey = this.getApiKey();
                    if (!apiKey) {
                        throw new Error('未设置API密钥');
                    }
                    
                    const data = await this.makeRequest(videoInfo, {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`
                        },
                        bodyExtra: {
                            response_format: { type: "json_object" }
                        }
                    });
                    return JSON.parse(data.choices[0].message.content);
                }
            } catch (error) {
                console.error('【VideoAdGuard】分析失败:', error);
                throw error;
            }
        },
        
        buildPrompt(videoInfo) {
            const prompt = `视频的标题和置顶评论如下，可供参考判断是否有植入广告。如果置顶评论中有购买链接，则肯定有广告，同时可以根据置顶评论的内容判断视频中的广告商从而确定哪部分是广告。
视频标题：${videoInfo.title}
置顶评论：${videoInfo.topComment || '无'}
下面我会给你这个视频的字幕字典，形式为 index: context. 请你完整地找出其中的植入广告，返回json格式的数据。注意要返回一整段的广告，从广告的引入到结尾重新转折回到视频内容前，因此不要返回太短的广告，可以组合成一整段返回。
字幕内容：${JSON.stringify(videoInfo.captions)}
先返回'exist': bool。true表示存在植入广告，false表示不存在植入广告。
再返回'index_lists': list[list[int]]。二维数组，行数表示广告的段数，一般来说视频是没有广告的，但也有小部分会植入一段广告，极少部分是多段广告，因此不要返回过多，只返回与标题最不相关或者与置顶链接中的商品最相关的部分。每一行是长度为2的数组[start, end]，表示一段广告的开头结尾，start和end是字幕的index。`;
            console.log('【VideoAdGuard】构建提示词成功:', prompt);
            return prompt;
        },

        getEnableLocalOllama() {
            return GM_getValue('enableLocalOllama', false);
        },
        
        getApiUrl() {
            return GM_getValue('apiUrl', DEFAULT_API_URL);
        },
        
        getApiKey() {
            return GM_getValue('apiKey', null);
        },
        
        getModel() {
            return GM_getValue('model', DEFAULT_MODEL);
        }
    };
    
    // 广告检测器类
    const AdDetector = {
        adDetectionResult: null,
        adTimeRanges: [],
        
        async getCurrentBvid() {
            const match = window.location.pathname.match(/\/video\/(BV[\w]+)/);
            if (!match) throw new Error('未找到视频ID');
            return match[1];
        },
        
        async analyze() {
            try {
                // 移除已存在的跳过按钮
                const existingButton = document.querySelector('.skip-ad-button10032');
                if (existingButton) {
                    existingButton.remove();
                }
                
                const bvid = await this.getCurrentBvid();
                
                // 获取视频信息
                const videoInfo = await BilibiliService.getVideoInfo(bvid);
                const comments = await BilibiliService.getComments(bvid);
                const playerInfo = await BilibiliService.getPlayerInfo(bvid, videoInfo.cid);
                
                // 获取字幕
                if (!playerInfo.subtitle?.subtitles?.length) {
                    console.log('【VideoAdGuard】无字幕');
                    this.adDetectionResult = '当前视频无字幕，无法检测';
                    return;
                }
                
                const captionsUrl = 'https:' + playerInfo.subtitle.subtitles[0].subtitle_url;
                const captionsData = await BilibiliService.getCaptions(captionsUrl);
                
                // 处理数据
                const captions = {};
                captionsData.body.forEach((caption, index) => {
                    captions[index] = caption.content;
                });
                
                // AI分析
                const result = await AIService.analyze({
                    title: videoInfo.title,
                    topComment: comments.upper?.top?.content?.message || null,
                    captions
                });
                
                if (result.exist) {
                    console.log('【VideoAdGuard】检测到广告片段:', JSON.stringify(result.index_lists));
                    const second_lists = this.index2second(result.index_lists, captionsData.body);
                    this.adTimeRanges = second_lists;
                    this.adDetectionResult = `发现${second_lists.length}处广告：${
                        second_lists.map(([start, end]) => `${this.second2time(start)}~${this.second2time(end)}`).join(' | ')
                    }`;
                    
                    // 添加控制台输出广告时间段
                    second_lists.forEach(([start, end]) => {
                        console.log(`【VideoAdGuard】检测到广告片段: [${this.second2time(start)}~${this.second2time(end)}]`);
                    });
                    
                    // 注入跳过按钮
                    this.injectSkipButton();
                    // 显示通知
                    this.showNotification(this.adDetectionResult);
                } else {
                    this.adDetectionResult = '无广告内容';
                    console.log('【VideoAdGuard】未检测到广告内容');
                }
                
            } catch (error) {
                console.error('分析失败:', error);
                this.adDetectionResult = '分析失败：' + error.message;
            }
        },
        
        index2second(indexLists, captions) {
            // 直接生成时间范围列表
            const time_lists = indexLists.map(list => {
                const start = captions[list[0]]?.from || 0;
                const end = captions[list[list.length - 1]]?.to || 0;
                return [start, end];
            });
            return time_lists;
        },
        
        second2time(seconds) {
            const hour = Math.floor(seconds / 3600);
            const min = Math.floor((seconds % 3600) / 60);
            const sec = Math.floor(seconds % 60);
            return `${hour > 0 ? hour + ':' : ''}${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
        },
        
        injectSkipButton() {
            const player = document.querySelector('.bpx-player-control-bottom');
            if (!player) return;
            
            const skipButton = document.createElement('button');
            skipButton.className = 'skip-ad-button10032';
            skipButton.textContent = '跳过广告';
            skipButton.style.cssText = `
                font-size: 14px;
                position: absolute;
                right: 20px;
                bottom: 100px;
                z-index: 999;
                padding: 4px 4px;
                color: #000000; 
                font-weight: bold;
                background: rgba(255, 255, 255, 0.7);
                border: none;
                border-radius: 4px;
                cursor: pointer;
            `;
            
            player.appendChild(skipButton);
            
            // 监听视频播放时间
            const video = document.querySelector('video');
            if (!video) {
                console.error('未找到视频元素');
                return;
            }
            
            // 点击跳过按钮
            skipButton.addEventListener('click', () => {
                const currentTime = video.currentTime;
                console.log('【VideoAdGuard】当前时间:', currentTime);
                const adSegment = this.adTimeRanges.find(([start, end]) => 
                    currentTime >= start && currentTime < end
                );
                
                if (adSegment) {
                    video.currentTime = adSegment[1]; // 跳到广告段结束时间
                    console.log('【VideoAdGuard】跳转时间:', adSegment[1]);
                }
            });
        },
        
        showNotification(message) {
            const notification = document.createElement('div');
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: rgba(0, 0, 0, 0.7);
                color: white;
                padding: 10px 15px;
                border-radius: 4px;
                z-index: 9999;
                max-width: 300px;
            `;
            notification.textContent = message;
            document.body.appendChild(notification);
            
            setTimeout(() => {
                notification.style.opacity = '0';
                notification.style.transition = 'opacity 0.5s';
                setTimeout(() => notification.remove(), 500);
            }, 5000);
        },
        
        // 添加设置面板
        addSettingsButton() {
            const settingsButton = document.createElement('button');
            settingsButton.textContent = '⚙️';
            settingsButton.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 40px;
                height: 40px;
                border-radius: 50%;
                background: rgba(0, 0, 0, 0.7);
                color: white;
                border: none;
                font-size: 20px;
                cursor: pointer;
                z-index: 9999;
            `;
            
            document.body.appendChild(settingsButton);
            
            settingsButton.addEventListener('click', () => {
                this.showSettingsPanel();
            });
        },
        
        showSettingsPanel() {
            // 移除已存在的面板
            const existingPanel = document.querySelector('.vag-settings-panel');
            if (existingPanel) {
                existingPanel.remove();
                return;
            }
            
            const panel = document.createElement('div');
            panel.className = 'vag-settings-panel';
            panel.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
                z-index: 10000;
                width: 300px;
                color: #333;
            `;
            
            // 添加样式
            const style = document.createElement('style');
            style.textContent = `
                .vag-settings-panel .form-group {
                    margin-bottom: 10px;
                }
                .vag-settings-panel label {
                    display: block;
                    margin-bottom: 5px;
                }
                .vag-settings-panel input[type="text"],
                .vag-settings-panel input[type="password"] {
                    width: 100%;
                    padding: 5px;
                    box-sizing: border-box;
                }
                .vag-settings-panel button {
                    width: 100%;
                    padding: 8px;
                    background-color: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    margin-bottom: 5px;
                }
                .vag-settings-panel button:hover {
                    background-color: #45a049;
                }
                .vag-settings-panel #vag-message {
                    margin-top: 10px;
                    padding: 5px;
                    border-radius: 4px;
                }
                .vag-settings-panel .success {
                    background-color: #dff0d8;
                    color: #3c763d;
                }
                .vag-settings-panel .error {
                    background-color: #f2dede;
                    color: #a94442;
                }
                .vag-settings-panel .localOllama-field {
                    display: flex;
                    align-items: top;
                    word-break: keep-all;
                }
                .vag-settings-panel .checkbox-container {
                    display: flex;
                    align-items: center;
                    position: relative;
                    padding-left: 30px;
                    cursor: pointer;
                    user-select: none;
                }
                .vag-settings-panel .checkbox-container input {
                    position: absolute;
                    opacity: 0;
                    cursor: pointer;
                    height: 0;
                    width: 0;
                }
                .vag-settings-panel .checkmark {
                    position: absolute;
                    left: 0;
                    height: 20px;
                    width: 20px;
                    background-color: #eee;
                    border-radius: 4px;
                    transition: all 0.2s;
                }
                .vag-settings-panel .checkbox-container:hover input ~ .checkmark {
                    background-color: #ccc;
                }
                .vag-settings-panel .checkbox-container input:checked ~ .checkmark {
                    background-color: #4CAF50;
                }
                .vag-settings-panel .checkmark:after {
                    content: "";
                    position: absolute;
                    display: none;
                }
                .vag-settings-panel .checkbox-container input:checked ~ .checkmark:after {
                    display: block;
                }
                .vag-settings-panel .checkbox-container .checkmark:after {
                    left: 7px;
                    top: 3px;
                    width: 5px;
                    height: 10px;
                    border: solid white;
                    border-width: 0 2px 2px 0;
                    transform: rotate(45deg);
                }
                .vag-settings-panel #vag-local-ollama {
                    width: auto;
                    margin-right: 5px;
                }
            `;
            document.head.appendChild(style);
            
            panel.innerHTML = `
                <h3>B站广告检测设置</h3>
                <div class="form-group localOllama-field">
                    <label for="vag-local-ollama" class="checkbox-container">
                        <input type="checkbox" id="vag-local-ollama" ${GM_getValue('enableLocalOllama', false) ? 'checked' : ''}>
                        <span class="checkmark"></span>
                        连接到本地Ollama
                    </label>
                </div>
                <div class="form-group">
                    <label for="vag-api-url">API地址：</label>
                    <input type="text" id="vag-api-url" placeholder="请输入API地址" value="${GM_getValue('apiUrl', DEFAULT_API_URL)}">
                </div>
                <div class="form-group apiKey-field" id="vag-api-key-group" style="${GM_getValue('enableLocalOllama', false) ? 'display:none' : ''}">
                    <label for="vag-api-key">API密钥：</label>
                    <input type="password" id="vag-api-key" placeholder="请输入API密钥" value="${GM_getValue('apiKey', '')}">
                </div>
                <div class="form-group">
                    <label for="vag-model">模型名称：</label>
                    <input type="text" id="vag-model" placeholder="请输入模型名称" value="${GM_getValue('model', DEFAULT_MODEL)}">
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <button id="vag-save" style="padding: 8px 15px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer;">
                        保存
                    </button>
                    <button id="vag-cancel" style="padding: 8px 15px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer;">
                        取消
                    </button>
                </div>
                <div id="vag-message"></div>
            `;
            
            document.body.appendChild(panel);
            
            // 获取元素
            const apiUrlInput = document.getElementById('vag-api-url');
            const apiKeyInput = document.getElementById('vag-api-key');
            const modelInput = document.getElementById('vag-model');
            const ollamaCheckbox = document.getElementById('vag-local-ollama');
            const apiKeyGroup = document.getElementById('vag-api-key-group');
            const messageDiv = document.getElementById('vag-message');
            
            // Ollama 复选框事件
            ollamaCheckbox.addEventListener('change', () => {
                apiKeyGroup.style.display = ollamaCheckbox.checked ? 'none' : 'block';
            });
            
            // 防止事件冒泡
            [apiUrlInput, apiKeyInput, modelInput, ollamaCheckbox].forEach(input => {
                input.addEventListener('click', e => e.stopPropagation());
                input.addEventListener('keydown', e => e.stopPropagation());
            });
            
            // 显示消息函数
            const showMessage = (message, type) => {
                messageDiv.textContent = message;
                messageDiv.className = type;
                setTimeout(() => {
                    messageDiv.textContent = '';
                    messageDiv.className = '';
                }, 3000);
            };
            
            // 保存按钮事件
            document.getElementById('vag-save').addEventListener('click', () => {
                const apiUrl = apiUrlInput.value;
                const apiKey = apiKeyInput.value;
                const model = modelInput.value;
                const enableLocalOllama = ollamaCheckbox.checked;
                
                if (!apiUrl) {
                    showMessage('请输入API地址', 'error');
                    return;
                }
                
                if (!enableLocalOllama && !apiKey) {
                    showMessage('请输入API密钥', 'error');
                    return;
                }
                
                if (!model) {
                    showMessage('请输入模型名称', 'error');
                    return;
                }
                
                GM_setValue('apiUrl', apiUrl);
                GM_setValue('apiKey', apiKey);
                GM_setValue('model', model);
                GM_setValue('enableLocalOllama', enableLocalOllama);
                
                showMessage('设置已保存', 'success');
                setTimeout(() => {
                    panel.remove();
                }, 1000);
            });
            
            // 取消按钮事件
            document.getElementById('vag-cancel').addEventListener('click', () => {
                panel.remove();
            });
        },
    };
    
    // 初始化
    function init() {
        // 页面加载完成后执行分析
        AdDetector.analyze();
        
        // 添加设置按钮
        AdDetector.addSettingsButton();
        
        // 添加 URL 变化监听
        let lastUrl = location.href;
        let lastBvid = null;

        // 提取BV号的辅助函数
        const extractBvidFromUrl = (url) => {
            const pathMatch = url.match(/BV[\w]+/);
            if (pathMatch) return pathMatch[0];

            try {
                const urlObj = new URL(url);
                const bvid = urlObj.searchParams.get('bvid');
                return bvid;
            } catch (e) {
                return null;
            }
        };

        new MutationObserver(() => {
            const url = location.href;
            if (url !== lastUrl) {
                const currentBvid = extractBvidFromUrl(url);
                const previousBvid = extractBvidFromUrl(lastUrl);

                lastUrl = url;

                // 只有当BV号发生变化时才触发检测逻辑
                if (currentBvid !== previousBvid) {
                    console.log('【VideoAdGuard】URL changed with different BV:', url, 'Previous BV:', previousBvid, 'Current BV:', currentBvid);
                    lastBvid = currentBvid;
                    AdDetector.analyze();
                } else {
                    console.log('【VideoAdGuard】URL changed but BV unchanged, skipping detection:', url);
                }
            }
        }).observe(document, { subtree: true, childList: true });
        
        // 监听 history 变化
        window.addEventListener('popstate', () => {
            console.log('【VideoAdGuard】History changed:', location.href);
            AdDetector.analyze();
        });
    }
    
    // 等待页面加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
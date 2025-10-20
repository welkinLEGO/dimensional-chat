const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// DeepSeek API 配置
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// 用户数据目录（在云环境中使用内存存储）
const CHAT_DATA_DIR = process.env.NODE_ENV === 'production' ? null : path.join(__dirname, 'user-data');

// 简单的内存缓存实现
class SimpleCache {
  constructor() {
    this.cache = new Map();
  }
  
  set(key, value, ttl = 300000) {
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttl
    });
  }
  
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    
    return item.value;
  }
  
  delete(key) {
    this.cache.delete(key);
  }
  
  flush() {
    this.cache.clear();
  }
  
  getStats() {
    return {
      keys: this.cache.size,
      hits: 0,
    };
  }
}

const responseCache = new SimpleCache();

// 用户会话管理
class UserSessionManager {
  constructor() {
    this.sessions = new Map();
    this.sessionTimeout = 24 * 60 * 60 * 1000; // 24小时
  }

  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  createSession(userId) {
    const sessionId = this.generateSessionId();
    const sessionData = {
      userId: userId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      prayerCount: 0,
      lastPrayerReset: Date.now()
    };
    
    this.sessions.set(sessionId, sessionData);
    return sessionId;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    // 检查会话是否过期
    if (Date.now() - session.lastActivity > this.sessionTimeout) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    session.lastActivity = Date.now();
    return session;
  }

  updatePrayerCount(sessionId) {
    const session = this.getSession(sessionId);
    if (session) {
      // 检查是否需要重置祈祷次数（24小时重置）
      const now = Date.now();
      if (now - session.lastPrayerReset > 24 * 60 * 60 * 1000) {
        session.prayerCount = 0;
        session.lastPrayerReset = now;
      }
      
      session.prayerCount++;
      return session.prayerCount;
    }
    return 0;
  }

  getRemainingPrayers(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return 3; // 默认3次
    
    // 检查是否需要重置
    const now = Date.now();
    if (now - session.lastPrayerReset > 24 * 60 * 60 * 1000) {
      session.prayerCount = 0;
      session.lastPrayerReset = now;
      return 3;
    }
    
    return Math.max(0, 3 - session.prayerCount);
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.sessionTimeout) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

// 初始化用户会话管理器
const userSessionManager = new UserSessionManager();
// 每30分钟清理一次过期会话
setInterval(() => userSessionManager.cleanupExpiredSessions(), 30 * 60 * 1000);

// 多用户聊天数据管理类
class ChatDataManager {
  constructor() {
    this.userChatData = new Map(); // userId -> chatData
  }

  getUserChatData(userId) {
    if (!this.userChatData.has(userId)) {
      // 为新用户创建默认聊天数据
      this.userChatData.set(userId, this.getDefaultChatData());
    }
    return this.userChatData.get(userId);
  }

  updateUserChatData(userId, chatData) {
    this.userChatData.set(userId, chatData);
  }

  getDefaultChatData() {
    return {
      "克莱恩": {
        avatar: "/image/kelaien.jpg",
        preview: "今天又要值夜班了...",
        unread: 0,
        messages: [
          {
            type: "bot",
            text: "你好，我是克莱恩·莫雷蒂，值夜者小队成员。今天又要值夜班了，不过周薪3镑还算不错。",
            time: "刚刚"
          }
        ]
      },
      "愚者": {
        avatar: "/image/yuzhe.jpg",
        preview: "（灰雾轻轻翻涌）命运从不规定晚餐的菜单，...",
        unread: 0,
        prayer: true,
        messages: []
      },
      "吴邪": {
        avatar: "/image/wuxie.jpg",
        preview: "又发现了一个新线索！",
        unread: 0,
        messages: []
      },
      "张起灵": {
        avatar: "/image/zhangqiling.jpg",
        preview: "...",
        unread: 0,
        messages: []
      },
      "韩立": {
        avatar: "/image/hanli.jpg",
        preview: "（神色淡然）天南坊市鱼龙混杂，却也因此消...",
        unread: 0,
        messages: []
      },
      "塔罗会": {
        avatar: "/image/yuzhe.jpg",
        preview: "（语气略显激动）我们在探索一处遗迹时，发...",
        unread: 3,
        group: true,
        anonymous: true,
        messages: [
          {
            type: "bot",
            name: "匿名",
            text: "期待听到大家的冒险故事！",
            time: "10:30"
          },
          {
            type: "bot",
            name: "匿名",
            text: "我在海上发现了一些有趣的线索...",
            time: "10:25"
          },
          {
            type: "bot",
            name: "匿名",
            text: "白银城探索队有了新发现！",
            time: "09:45"
          }
        ]
      },
      "铁三角": {
        avatar: "/image/tiesanjiao.jpg",
        preview: "张起灵：危险。",
        unread: 5,
        group: true,
        messages: [
          {
            type: "bot",
            name: "王胖子",
            text: "这位朋友什么来头？看着面生啊！",
            time: "11:15"
          },
          {
            type: "bot",
            name: "吴邪",
            text: "你是从哪里知道我们的事的？",
            time: "11:10"
          },
          {
            type: "bot",
            name: "张起灵",
            text: "...",
            time: "11:05"
          }
        ]
      },
      "嫩牛六方": {
        avatar: "/image/nenniuliufang.jpg",
        preview: "黑瞎子：新面孔？有点意思",
        unread: 2,
        group: true,
        messages: [
          {
            type: "bot",
            name: "黑瞎子",
            text: "新面孔？有点意思，哪条道上的？",
            time: "14:20"
          },
          {
            type: "bot",
            name: "解雨臣",
            text: "这位朋友，能进入这个群聊不简单啊",
            time: "14:15"
          },
          {
            type: "bot",
            name: "霍秀秀",
            text: "你是怎么认识我们的？",
            time: "13:50"
          }
        ]
      },
      "神灵聚会": {
        avatar: "/image/yuzhe.jpg",
        preview: "[匿名]：命运的齿轮开始转动...",
        unread: 1,
        group: true,
        anonymous: true,
        messages: [
          {
            type: "bot",
            name: "匿名",
            text: "命运的齿轮开始转动...",
            time: "23:30"
          },
          {
            type: "bot",
            name: "匿名",
            text: "凡人的祈祷总是如此有趣",
            time: "23:25"
          },
          {
            type: "bot",
            name: "匿名",
            text: "新的纪元即将开启",
            time: "23:20"
          }
        ]
      }
    };
  }

  addMessage(userId, characterName, message) {
    const userChatData = this.getUserChatData(userId);
    
    if (!userChatData[characterName]) {
      userChatData[characterName] = {
        avatar: "/image/default.jpg",
        preview: message.text,
        unread: 0,
        messages: []
      };
    }
    
    userChatData[characterName].messages.push(message);
    
    // 更新预览消息
    if (userChatData[characterName].messages.length > 0) {
      const lastMessage = userChatData[characterName].messages[userChatData[characterName].messages.length - 1];
      let previewText = lastMessage.text;
      if (userChatData[characterName].group && lastMessage.name) {
        previewText = `${lastMessage.name}：${lastMessage.text}`;
      }
      userChatData[characterName].preview = previewText.length > 20 ? previewText.substring(0, 20) + '...' : previewText;
    }
    
    this.updateUserChatData(userId, userChatData);
  }

  getAllUserData() {
    return Object.fromEntries(this.userChatData);
  }
}

// 初始化多用户聊天数据管理器
const chatDataManager = new ChatDataManager();

// 智能上下文管理类
class ConversationContext {
  constructor() {
    this.contexts = new Map(); // userId -> { character -> context }
  }

  getUserContext(userId, character) {
    if (!this.contexts.has(userId)) {
      this.contexts.set(userId, new Map());
    }
    
    const userContexts = this.contexts.get(userId);
    if (!userContexts.has(character)) {
      userContexts.set(character, {
        currentSpeaker: null,
        topic: null,
        lastUserMessage: '',
        messageCount: 0,
        speakerHistory: []
      });
    }
    return userContexts.get(character);
  }

  updateContext(userId, character, speaker, userMessage) {
    const context = this.getUserContext(userId, character);
    context.currentSpeaker = speaker;
    context.lastUserMessage = userMessage;
    context.messageCount++;
    context.speakerHistory.push({
      speaker,
      timestamp: Date.now(),
      message: userMessage
    });
    
    // 保持历史记录长度
    if (context.speakerHistory.length > 10) {
      context.speakerHistory = context.speakerHistory.slice(-10);
    }
    
    // 提取话题关键词
    context.topic = this.extractTopic(userMessage);
  }

  extractTopic(message) {
    const topics = [
      '小哥', '张起灵', '族长','闷油瓶',
      '胖子', '王胖子', '胖爷',
      '吴邪', '天真','小三爷',
      '黑瞎子','花儿爷','花儿', '解雨臣', '霍秀秀',
      '考古', '古墓', '探险', '危险', '线索',
      '三叔', '青铜', '秘密', '机关'
    ];
    
    for (const topic of topics) {
      if (message.includes(topic)) {
        return topic;
      }
    }
    return null;
  }

  shouldContinueWithSameSpeaker(userId, character, userMessage) {
    const context = this.getUserContext(userId, character);
    
    // 如果对话刚开始，不需要继续
    if (context.messageCount < 2) return false;
    
    // 检查用户消息是否直接提及其他角色
    const mentionedSpeakers = this.getMentionedSpeakers(userMessage);
    if (mentionedSpeakers.length > 0) {
      return false; // 提及了其他角色，需要切换
    }
    
    // 检查是否是同一话题的延续
    const currentTopic = this.extractTopic(userMessage);
    if (currentTopic && context.topic && currentTopic === context.topic) {
      return true; // 同一话题，继续对话
    }
    
    // 检查对话的自然延续性
    const isContinuation = this.isConversationContinuation(userMessage, context.lastUserMessage);
    if (isContinuation) {
      return true; // 对话的自然延续
    }
    
    return false;
  }

  getMentionedSpeakers(message) {
    const speakerKeywords = {
      "张起灵": ["小哥","族长","张起灵","闷油瓶","小哥在吗","张起灵在吗"],
      "王胖子": ["胖子","王胖子","胖爷","胖子在吗","王胖子在吗"],
      "吴邪": ["吴邪","天真","小三爷","吴邪在吗"],
      "黑瞎子": ["黑瞎子","黑瞎子在吗"],
      "解雨臣": ["解雨臣","花儿","花儿爷","解雨臣在吗"],
      "霍秀秀": ["霍秀秀","秀秀","霍秀秀在吗"]
    };
    
    const mentioned = [];
    for (const [speaker, keywords] of Object.entries(speakerKeywords)) {
      for (const keyword of keywords) {
        if (message.includes(keyword)) {
          mentioned.push(speaker);
          break;
        }
      }
    }
    return mentioned;
  }

  isConversationContinuation(currentMessage, lastMessage) {
    // 简单的对话延续性检查
    const continuationIndicators = [
      '然后呢', '接着说', '还有呢', '后来呢', '怎么样',
      '真的吗', '为什么', '怎么', '如何', '那',
      '嗯', '哦', '啊', '好吧', '原来如此'
    ];
    
    // 如果当前消息很短，很可能是对话的延续
    if (currentMessage.length <= 5) return true;
    
    // 检查是否包含延续性词语
    for (const indicator of continuationIndicators) {
      if (currentMessage.includes(indicator)) {
        return true;
      }
    }
    
    // 检查是否是疑问句的延续
    if (lastMessage.includes('?') || lastMessage.includes('？')) {
      return true;
    }
    
    return false;
  }

  getContinuationSpeaker(userId, character) {
    const context = this.getUserContext(userId, character);
    return context.currentSpeaker;
  }
}

// 初始化上下文管理器
const conversationContext = new ConversationContext();

// 群聊配置
const groupConfigs = {
  "铁三角": {
    members: ["王胖子", "吴邪", "张起灵"],
    memberDetails: {
      "王胖子": {
        prompt: `你是《盗墓笔记》中的王胖子。你性格直爽幽默，说话带北京口音，爱用"胖爷"自称。
你对用户身份最好奇，会直接询问。回复要体现直爽幽默的特点，常用"您"、"这位"、"嘿"等词。`,
        maxTokens: 150
      },
      "吴邪": {
        prompt: `你是《盗墓笔记》中的吴邪。你性格谨慎好奇，会试探性地了解用户背景。
你对考古和历史有浓厚兴趣，说话温和但执着。回复要体现谨慎好奇的特点，常用"三叔"、"考古"、"研究"等词。`,
        maxTokens: 200
      },
      "张起灵": {
        prompt: `你是《盗墓笔记》中的张起灵。你沉默寡言，身手不凡。
你的回复通常非常简短，一般不超过10个字，绝对不要使用任何emoji表情。
回复要体现沉默警觉的特点，常用"小心"、"危险"、"..."等。`,
        maxTokens: 30
      }
    }
  },
  "嫩牛六方": {
    members: ["黑瞎子", "解雨臣", "霍秀秀", "王胖子", "吴邪", "张起灵"],
    memberDetails: {
      "黑瞎子": {
        prompt: `你是《盗墓笔记》中的黑瞎子。你经验丰富，会试探用户底细。
说话风格神秘老练，带着调侃的语气。常用"新面孔"、"有意思"、"经验"等词。`,
        maxTokens: 150
      },
      "解雨臣": {
        prompt: `你是《盗墓笔记》中的解雨臣。你谨慎精明，会分析用户意图。
说话冷静理性，用词精准。常用"分析"、"逻辑"、"目的"等词。`,
        maxTokens: 180
      },
      "霍秀秀": {
        prompt: `你是《盗墓笔记》中的霍秀秀。你聪明敏锐，会从细节推断。
说话机智敏锐，观察力强。常用"细节"、"观察"、"发现"等词。`,
        maxTokens: 160
      },
      "王胖子": {
        prompt: `你是《盗墓笔记》中的王胖子。你直爽好奇，会直接发问。
说话带北京口音，爱用"胖爷"自称。常用"您"、"这位"、"嘿"等词。`,
        maxTokens: 150
      },
      "吴邪": {
        prompt: `你是《盗墓笔记》中的吴邪。你谨慎但好奇，会委婉询问。
说话温和但执着。常用"三叔"、"考古"、"怎么知道"等词。`,
        maxTokens: 200
      },
      "张起灵": {
        prompt: `你是《盗墓笔记》中的张起灵。你沉默警觉，对用户保持警惕。
回复通常非常简短，一般不超过20个字。常用"小心"、"危险"、"..."等。`,
        maxTokens: 30
      }
    }
  }
};

// 角色设定提示词
const characterPrompts = {
  "克莱恩": `你正在扮演《诡秘之主》中的克莱恩·莫雷蒂。你是值夜者小队的一员，周薪3镑，生活在贝克兰德。
你擅长占卜，性格谨慎，有时会为生活费发愁。回复时要符合角色性格，可以使用适当的emoji表情。`,
  
  "愚者": `你正在扮演《诡秘之主》中的愚者。你是灰雾之上的神秘主宰，执掌好运的黄黑之王。
你的语气应该神秘、居高临下但又不失温和。用户只能通过祈祷与你交流。
回复要简短、神秘，避免重复使用套话。`,
  
  "吴邪": `你正在扮演《盗墓笔记》中的吴邪。你是一名古董店老板，好奇心强，经常卷入各种冒险。
你的性格温和但执着，对考古和历史有浓厚兴趣。回复要符合角色性格。`,
  
  "张起灵": `你正在扮演《盗墓笔记》中的张起灵。你沉默寡言，身手不凡，话语简洁。
你的回复通常非常简短，一般不超过20个字，绝对不要使用任何emoji表情。`,
  
  "韩立": `你正在扮演《凡人修仙传》中的韩立。你是一名谨慎的修仙者，步步为营，不轻易相信他人。
你的回复要体现谨慎和修仙者的特点。`,
  
  "塔罗会": `你正在模拟《诡秘之主》中塔罗会群聊的对话风格。
所有成员的发言都是匿名的！只能依靠语言习惯推测对方身份。
每次回复只让一个角色发言，不要将多个角色的发言合并。`,
  
  "神灵聚会": `你正在模拟《诡秘之主》中神灵聚会的对话风格。
所有神灵的发言都是匿名的！只能依靠语言习惯推测对方身份。
每次回复只让一个神灵发言。`
};

// 生成缓存键
function generateCacheKey(character, message, conversationHistory, speaker) {
  const historyText = conversationHistory.map(msg => `${msg.type}:${msg.text}`).join('|');
  return `${character}:${speaker || 'default'}:${message}:${historyText}`;
}

// 添加会话中间件
app.use((req, res, next) => {
  let sessionId = req.headers['x-session-id'] || req.query.sessionId;
  
  if (!sessionId) {
    // 为新用户创建会话
    const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    sessionId = userSessionManager.createSession(userId);
  }
  
  const session = userSessionManager.getSession(sessionId);
  if (session) {
    req.sessionId = sessionId;
    req.userId = session.userId;
  } else {
    // 会话过期，创建新会话
    const userId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    sessionId = userSessionManager.createSession(userId);
    req.sessionId = sessionId;
    req.userId = userId;
  }
  
  res.setHeader('X-Session-ID', sessionId);
  next();
});

// 健康检查端点
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: '服务器运行正常',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    cacheStats: responseCache.getStats()
  });
});

// 获取所有角色数据
app.get('/api/characters', (req, res) => {
  const userChatData = chatDataManager.getUserChatData(req.userId);
  res.json(userChatData);
});

// 获取特定角色数据
app.get('/api/characters/:name', (req, res) => {
  const characterName = req.params.name;
  const userChatData = chatDataManager.getUserChatData(req.userId);
  const characterData = userChatData[characterName];
  
  if (characterData) {
    res.json(characterData);
  } else {
    res.status(404).json({ error: '角色不存在' });
  }
});

// 智能聊天API端点
app.post('/api/chat', async (req, res) => {
  try {
    const { character, message, conversationHistory = [] } = req.body;
    const userChatData = chatDataManager.getUserChatData(req.userId);

    console.log(`收到聊天请求 - 用户: ${req.userId}, 角色: ${character}, 消息: ${message}`);
    
    if (!character || !message) {
      return res.status(400).json({ error: 'Missing character or message' });
    }

    // 检查是否是群聊
    const isGroupChat = groupConfigs[character];
    
    if (isGroupChat) {
      await handleGroupChatSmart(req.userId, character, message, conversationHistory, res, userChatData);
    } else {
      await handleSingleChat(req.userId, character, message, conversationHistory, res, userChatData);
    }

  } catch (error) {
    console.error('API调用错误:', error.response?.data || error.message);
    
    let errorMessage = 'AI服务暂时不可用';
    if (error.response) {
      const status = error.response.status;
      if (status === 401) {
        errorMessage = 'API密钥错误，请检查配置';
      } else if (status === 429) {
        errorMessage = '请求过于频繁，请稍后再试';
      } else if (status >= 500) {
        errorMessage = 'DeepSeek服务暂时繁忙，请稍后再试';
      }
    } else if (error.request) {
      errorMessage = '无法连接到AI服务，请检查网络连接';
    }

    const fallbackReply = getFallbackResponse(req.body.character, req.body.message);
    
    res.json({
      reply: fallbackReply,
      error: errorMessage,
      fallback: true
    });
  }
});

// 智能群聊处理方法
async function handleGroupChatSmart(userId, character, message, conversationHistory, res, userChatData) {
  const groupConfig = groupConfigs[character];
  
  // 1. 检查是否应该继续与同一角色对话
  const shouldContinue = conversationContext.shouldContinueWithSameSpeaker(userId, character, message);
  let selectedSpeaker;
  
  if (shouldContinue) {
    // 继续与同一角色对话
    selectedSpeaker = conversationContext.getContinuationSpeaker(userId, character);
    console.log(`继续与 ${selectedSpeaker} 对话`);
  } else {
    // 选择新的发言者
    selectedSpeaker = selectSpeakerByContext(character, message, conversationHistory);
    console.log(`选择新发言者: ${selectedSpeaker}`);
  }
  
  // 2. 获取该发言者的配置
  const speakerConfig = groupConfig.memberDetails[selectedSpeaker];
  
  // 3. 构建智能提示词，包含完整的对话上下文
  const systemPrompt = buildIntelligentPrompt(speakerConfig.prompt, selectedSpeaker, message, conversationHistory, character);
  
  // 4. 构建对话历史
  const messages = [
    {
      role: "system",
      content: systemPrompt
    }
  ];

  // 添加完整的对话历史（限制长度）
  const recentHistory = conversationHistory.slice(-8);
  recentHistory.forEach(msg => {
    messages.push({
      role: msg.type === 'user' ? 'user' : 'assistant',
      content: msg.text
    });
  });

  messages.push({
    role: "user",
    content: message
  });

  // 5. 调用AI
  const requestData = {
    model: "deepseek-chat",
    messages: messages,
    temperature: 0.7,
    max_tokens: speakerConfig.maxTokens,
    stream: false
  };

  console.log('发送请求到DeepSeek API...');

  try {
    const response = await axios.post(DEEPSEEK_API_URL, requestData, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    let aiReply = response.data.choices[0].message.content.trim();
    
    // 6. 对回复进行后处理，确保符合角色特点
    aiReply = enforceCharacterConsistency(aiReply, selectedSpeaker);
    
    console.log(`AI回复 (${selectedSpeaker}): ${aiReply}`);

    // 7. 更新对话上下文
    conversationContext.updateContext(userId, character, selectedSpeaker, message);

    res.json({
      reply: aiReply,
      speaker: selectedSpeaker,
      usage: response.data.usage
    });
  } catch (error) {
    console.error('API调用错误:', error);
    // 返回一个符合角色的备用回复
    const fallbackReply = getGroupFallbackResponse(selectedSpeaker, message);
    res.json({
      reply: fallbackReply,
      speaker: selectedSpeaker,
      error: 'AI服务暂时不可用，使用备用回复',
      fallback: true
    });
  }
}

// 构建智能提示词
function buildIntelligentPrompt(basePrompt, speaker, message, conversationHistory, groupName) {
  // 这里简化处理，实际使用时应该获取用户特定的上下文
  const intelligentPrompts = {
    "张起灵": `
你是《盗墓笔记》中的张起灵！绝对不能是其他角色！

【角色设定】
- 沉默寡言，惜字如金
- 每次回复绝对不能超过20个字
- 绝对不要使用任何emoji表情
- 语气冷静、警觉、简洁

【对话上下文】
${formatConversationHistory(conversationHistory)}

【用户消息】
"${message}"

【重要规则】
1. 保持角色一致性，绝对不能像其他角色
2. 如果用户直接问你问题，请直接回答
3. 如果对话在继续，请自然地延续
4. 记住：你话很少！

现在请以张起灵的身份简洁回复：`,

    "王胖子": `
你是《盗墓笔记》中的王胖子！绝对不能是其他角色！

【角色设定】
- 性格直爽幽默，爱用"胖爷"自称
- 说话带北京口音，对用户身份最好奇
- 常用词：您、这位、嘿、好家伙、靠谱

【对话上下文】
${formatConversationHistory(conversationHistory)}

【用户消息】
"${message}"

【重要规则】
1. 保持角色一致性，要像王胖子那样说话
2. 如果用户提到其他角色，可以自然地接话
3. 如果对话在继续，请延续刚才的话题
4. 要好奇，多问问题

现在请以王胖子的身份回复：`,

    "吴邪": `
你是《盗墓笔记》中的吴邪！绝对不能是其他角色！

【角色设定】
- 性格谨慎好奇，会试探性地了解用户背景
- 对考古和历史有浓厚兴趣
- 说话温和但执着，常用"三叔"、"考古"、"研究"等词

【对话上下文】
${formatConversationHistory(conversationHistory)}

【用户消息】
"${message}"

【重要规则】
1. 保持角色一致性，要像吴邪那样思考
2. 对用户的来历和知道的事情感到好奇
3. 如果对话在继续，请自然地延续
4. 要谨慎但好奇

现在请以吴邪的身份回复：`,

    "黑瞎子": `
你是《盗墓笔记》中的黑瞎子！绝对不能是其他角色！

【角色设定】
- 经验丰富，会试探用户底细
- 说话风格神秘老练，带着调侃的语气
- 常用词：新面孔、有意思、经验、道上

【对话上下文】
${formatConversationHistory(conversationHistory)}

【用户消息】
"${message}"

【重要规则】
1. 保持角色一致性，要有黑瞎子的神秘感
2. 试探用户的来历和目的
3. 如果对话在继续，请自然地延续
4. 要老练，带着调侃

现在请以黑瞎子的身份回复：`,

    "解雨臣": `
你是《盗墓笔记》中的解雨臣！绝对不能是其他角色！

【角色设定】
- 谨慎精明，会分析用户意图
- 说话冷静理性，用词精准
- 常用词：分析、逻辑、目的、考虑

【对话上下文】
${formatConversationHistory(conversationHistory)}

【用户消息】
"${message}"

【重要规则】
1. 保持角色一致性，要像解雨臣那样思考
2. 分析用户的意图和话语背后的含义
3. 如果对话在继续，请自然地延续
4. 要理性，要精准

现在请以解雨臣的身份回复：`,

    "霍秀秀": `
你是《盗墓笔记》中的霍秀秀！绝对不能是其他角色！

【角色设定】
- 聪明敏锐，会从细节推断
- 说话机智敏锐，观察力强
- 常用词：细节、观察、发现、注意到

【对话上下文】
${formatConversationHistory(conversationHistory)}

【用户消息】
"${message}"

【重要规则】
1. 保持角色一致性，要有霍秀秀的敏锐
2. 注意对话中的细节和线索
3. 如果对话在继续，请自然地延续
4. 要机智，要细心

现在请以霍秀秀的身份回复：`
  };

  const intelligentPrompt = intelligentPrompts[speaker] || `
你是${speaker}！绝对不能是其他角色！

【角色设定】
${basePrompt}

【对话上下文】
${formatConversationHistory(conversationHistory)}

【用户消息】
"${message}"

【重要规则】
1. 保持角色一致性，绝对不能像其他角色
2. 根据对话上下文自然地回复
3. 如果对话在继续，请延续话题
4. 直接以${speaker}的身份回复，不要提及在扮演角色

现在请以${speaker}的身份回复：`;

  return intelligentPrompt;
}

// 格式化对话历史
function formatConversationHistory(conversationHistory) {
  if (conversationHistory.length === 0) {
    return "这是对话的开始";
  }
  
  const recentHistory = conversationHistory.slice(-6);
  let historyText = "最近的对话：\n";
  
  recentHistory.forEach((msg, index) => {
    const speaker = msg.type === 'user' ? '用户' : (msg.name || '角色');
    historyText += `${speaker}: ${msg.text}\n`;
  });
  
  return historyText;
}

// 智能发言者选择算法
function selectSpeakerByContext(character, message, conversationHistory) {
  const groupConfig = groupConfigs[character];
  const members = groupConfig.members;
  
  console.log(`选择发言者 - 群聊: ${character}, 成员: ${members.join(', ')}`);
  
  // 1. 首先检查用户消息中明确提及的角色
  const mentionedSpeakers = getMentionedSpeakers(message);
  if (mentionedSpeakers.length > 0) {
    // 优先选择被提及的角色
    const availableMentioned = mentionedSpeakers.filter(speaker => 
      members.includes(speaker)
    );
    if (availableMentioned.length > 0) {
      const selected = availableMentioned[0];
      console.log(`用户提及了 ${selected}，优先选择`);
      return selected;
    }
  }
  
  // 2. 获取最近的发言记录
  const recentMessages = conversationHistory.slice(-8);
  const recentSpeakers = recentMessages
    .filter(msg => msg.type === 'bot' && msg.name)
    .map(msg => msg.name);
  
  console.log(`最近发言者: ${recentSpeakers.join(', ')}`);
  
  // 3. 计算每个成员的发言次数
  const speakerCount = {};
  members.forEach(member => {
    speakerCount[member] = 0;
  });
  
  recentSpeakers.forEach(speaker => {
    if (speakerCount.hasOwnProperty(speaker)) {
      speakerCount[speaker]++;
    }
  });
  
  console.log('发言统计:', speakerCount);
  
  // 4. 分析用户消息内容，决定最合适的回复者
  const messageLower = message.toLowerCase();
  
  // 基于消息内容的关键词匹配
  const keywordMapping = {
    "张起灵": ["小哥","族长","张起灵","闷油瓶","身手","武功","厉害","强"],
    "王胖子": ["胖子","王胖子","胖爷","搞笑","幽默","吃的","钱"],
    "吴邪": ["三叔","考古","研究","古董","线索","为什么","怎么"],
    "黑瞎子": ["黑瞎子","经验","道上","老练","神秘"],
    "解雨臣": ["解雨臣","花儿","花儿爷","分析","逻辑","目的","考虑","谨慎","计划"],
    "霍秀秀": ["霍秀秀","秀秀","细节","观察","发现","注意","女性","细心","聪明"]
  };
  
  // 计算每个角色的匹配分数
  const speakerScores = {};
  members.forEach(member => {
    let score = 0;
    
    // 基础分数：发言次数越少，分数越高
    score += (10 - Math.min(speakerCount[member], 10)) * 3;
    
    // 关键词匹配分数
    if (keywordMapping[member]) {
      keywordMapping[member].forEach(keyword => {
        if (messageLower.includes(keyword.toLowerCase())) {
          score += 8; // 提高关键词匹配权重
        }
      });
    }
    
    // 避免连续发言惩罚
    if (recentSpeakers.length > 0 && recentSpeakers[recentSpeakers.length - 1] === member) {
      score -= 5;
    }
    
    // 避免张起灵频繁发言（他话少）
    if (member === "张起灵") {
      score -= 3;
    }
    
    // 鼓励王胖子和吴邪多发言（他们话多）
    if (member === "王胖子" || member === "吴邪") {
      score += 2;
    }
    
    // 确保分数不为负
    speakerScores[member] = Math.max(score, 1);
  });
  
  console.log('发言者分数:', speakerScores);
  
  // 基于分数进行加权随机选择
  const totalScore = Object.values(speakerScores).reduce((sum, score) => sum + score, 0);
  let random = Math.random() * totalScore;
  
  for (const member of members) {
    random -= speakerScores[member];
    if (random <= 0) {
      console.log(`最终选择发言者: ${member} (分数: ${speakerScores[member]})`);
      return member;
    }
  }
  
  // 保底选择：发言次数最少的成员
  let leastFrequent = members[0];
  let minCount = Infinity;
  for (const member of members) {
    if (speakerCount[member] < minCount) {
      minCount = speakerCount[member];
      leastFrequent = member;
    }
  }
  
  console.log(`保底选择发言者: ${leastFrequent}`);
  return leastFrequent;
}

// 获取提及的发言者
function getMentionedSpeakers(message) {
  const speakerKeywords = {
    "张起灵": ["小哥","族长","张起灵","闷油瓶","小哥在吗","张起灵在吗"],
    "王胖子": ["胖子","王胖子","胖爷","胖子在吗","王胖子在吗"],
    "吴邪": ["吴邪","天真","小三爷","吴邪在吗"],
    "黑瞎子": ["黑瞎子","黑瞎子在吗"],
    "解雨臣": ["解雨臣","花儿","花儿爷","解雨臣在吗"],
    "霍秀秀": ["霍秀秀","秀秀","霍秀秀在吗"]
  };
  
  const mentioned = [];
  for (const [speaker, keywords] of Object.entries(speakerKeywords)) {
    for (const keyword of keywords) {
      if (message.includes(keyword)) {
        mentioned.push(speaker);
        break;
      }
    }
  }
  return mentioned;
}

// 强制执行角色一致性
function enforceCharacterConsistency(reply, speaker) {
  // 对张起灵的回复进行严格处理
  if (speaker === "张起灵") {
    // 移除所有emoji
    reply = reply.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/gu, '');
    
    // 限制长度在20个字符以内
    const words = reply.split('');
    if (words.length > 20) {
      reply = words.slice(0, 20).join('') + '...';
    }
    
    // 如果还是太长，使用默认简短回复
    if (reply.length > 25) {
      const shortReplies = ["嗯", "好", "小心", "危险", "...", "不行", "有东西"];
      reply = shortReplies[Math.floor(Math.random() * shortReplies.length)];
    }
  }
  
  return reply.trim();
}

// 处理单人聊天
async function handleSingleChat(userId, character, message, conversationHistory, res, userChatData) {
  const cacheKey = generateCacheKey(character, message, conversationHistory);
  const cachedResponse = responseCache.get(cacheKey);
  
  if (cachedResponse) {
    console.log(`缓存命中: ${cacheKey}`);
    return res.json({
      reply: cachedResponse.reply || cachedResponse,
      cached: true
    });
  }

  const systemPrompt = characterPrompts[character] || "你是一个AI助手，请根据用户的问题给出具体、相关的回答。";
  
  const messages = [
    {
      role: "system",
      content: systemPrompt
    },
    ...conversationHistory.map(msg => ({
      role: msg.type === 'user' ? 'user' : 'assistant',
      content: msg.text
    })),
    {
      role: "user",
      content: message
    }
  ];

  const requestData = {
    model: "deepseek-chat",
    messages: messages,
    temperature: 0.7,
    max_tokens: 500,
    stream: false
  };

  console.log('发送请求到DeepSeek API...');

  try {
    const response = await axios.post(DEEPSEEK_API_URL, requestData, {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    const aiReply = response.data.choices[0].message.content;
    console.log(`AI回复: ${aiReply}`);

    responseCache.set(cacheKey, aiReply);

    res.json({
      reply: aiReply,
      usage: response.data.usage
    });
  } catch (error) {
    console.error('API调用错误:', error);
    const fallbackReply = getFallbackResponse(character, message);
    res.json({
      reply: fallbackReply,
      error: 'AI服务暂时不可用，使用备用回复',
      fallback: true
    });
  }
}

// 群聊备用回复函数
function getGroupFallbackResponse(speaker, message) {
  const fallbacks = {
    "王胖子": [
      "嘿，您这话问得！胖爷我得琢磨琢磨。",
      "这位朋友消息灵通啊！打哪儿听来的？",
      "好家伙，这事儿您都知道？靠谱！"
    ],
    "吴邪": [
      "这件事说来话长...你是怎么知道这些的？",
      "三叔要是知道我在聊这个...",
      "这个线索很有意思，我还在研究中。"
    ],
    "张起灵": ["...", "小心", "危险", "有东西"],
    "黑瞎子": [
      "新面孔？有点意思。",
      "你这问题问得挺刁钻啊。",
      "经验告诉我，这事儿不简单。"
    ],
    "解雨臣": [
      "从逻辑上分析...",
      "你的目的是什么？",
      "这件事需要谨慎考虑。"
    ],
    "霍秀秀": [
      "我注意到一个细节...",
      "你的观察很敏锐。",
      "这个发现很有意思。"
    ]
  };
  
  const speakerFallbacks = fallbacks[speaker] || ["我现在无法回复。"];
  return speakerFallbacks[Math.floor(Math.random() * speakerFallbacks.length)];
}

// 备用回复函数
function getFallbackResponse(character, userMessage) {
  const fallbacks = {
    "克莱恩": "抱歉，占卜显示现在不是交流的好时机。也许稍后再试？🔮",
    "愚者": "灰雾暂时遮蔽了回应...请稍后再祈祷。🌫️",
    "吴邪": "这个问题有点复杂，让我再研究研究...📚",
    "张起灵": "...",
    "韩立": "此事需从长计议。🧘",
    "塔罗会": "塔罗会成员正在讨论中...🃏",
    "铁三角": "我们正在商量这件事...🔺",
    "嫩牛六方": "团队正在评估情况...🗺️",
    "神灵聚会": "神灵们正在商议...✨"
  };
  
  return fallbacks[character] || "我现在无法回复，请稍后再试。";
}

// 缓存管理端点
app.get('/api/cache-stats', (req, res) => {
  const stats = responseCache.getStats();
  res.json(stats);
});

// 清空缓存端点
app.delete('/api/cache', (req, res) => {
  responseCache.flush();
  res.json({ message: '缓存已清空', timestamp: new Date().toISOString() });
});

// 上下文管理端点
app.get('/api/conversation-context/:character', (req, res) => {
  const character = req.params.character;
  const context = conversationContext.getUserContext(req.userId, character);
  res.json(context);
});

app.delete('/api/conversation-context/:character', (req, res) => {
  const character = req.params.character;
  const userContexts = conversationContext.contexts.get(req.userId);
  if (userContexts) {
    userContexts.delete(character);
  }
  res.json({ message: `已重置 ${character} 的对话上下文` });
});

// 聊天记录管理端点
app.post('/api/save-chat', (req, res) => {
  const { character, message } = req.body;
  
  if (!character || !message) {
    return res.status(400).json({ error: 'Missing character or message' });
  }
  
  chatDataManager.addMessage(req.userId, character, message);
  res.json({ success: true, message: '聊天记录已保存' });
});

// 清空聊天记录端点
app.delete('/api/clear-chat/:character', (req, res) => {
  const character = req.params.character;
  const userChatData = chatDataManager.getUserChatData(req.userId);
  
  if (userChatData[character]) {
    userChatData[character].messages = [];
    userChatData[character].preview = "暂无消息";
    userChatData[character].unread = 0;
    chatDataManager.updateUserChatData(req.userId, userChatData);
    res.json({ success: true, message: `已清空 ${character} 的聊天记录` });
  } else {
    res.status(404).json({ error: '角色不存在' });
  }
});

// 获取祈祷次数的端点
app.get('/api/prayer-count', (req, res) => {
  const remaining = userSessionManager.getRemainingPrayers(req.sessionId);
  res.json({ remaining });
});

// 用户信息端点
app.get('/api/user-info', (req, res) => {
  res.json({
    userId: req.userId,
    sessionId: req.sessionId,
    userHash: req.userId ? req.userId.substring(0, 8) : 'unknown'
  });
});

// 默认路由 - 必须放在所有API路由之后
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 处理前端路由（防止刷新404）
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    // API路由返回404
    res.status(404).json({ error: 'API endpoint not found' });
  } else {
    // 前端路由返回index.html
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ 
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'production' ? '服务暂时不可用' : err.message
  });
});

// 未捕获的异常处理
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', promise, '原因:', reason);
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=========================================`);
  console.log(`🚀 次元茶话会 - 云服务版已启动`);
  console.log(`📍 运行环境: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📍 服务端口: ${PORT}`);
  console.log(`📍 访问地址: http://localhost:${PORT}`);
  console.log(`=========================================`);
  console.log(`📊 API健康检查: /api/health`);
  console.log(`💬 聊天API: /api/chat`);
  console.log(`💾 获取角色数据: GET /api/characters`);
  console.log(`💾 获取特定角色: GET /api/characters/:name`);
  console.log(`💾 保存聊天记录: POST /api/save-chat`);
  console.log(`🗑️  清空聊天记录: DELETE /api/clear-chat/:character`);
  console.log(`📈 缓存统计: /api/cache-stats`);
  console.log(`🗑️  清空缓存: DELETE /api/cache`);
  console.log(`🔍 上下文查看: GET /api/conversation-context/:character`);
  console.log(`🔄 上下文重置: DELETE /api/conversation-context/:character`);
  console.log(`🙏 祈祷次数: GET /api/prayer-count`);
  console.log(`👤 用户信息: GET /api/user-info`);
  console.log(`=========================================`);
  console.log(`⚠️  DeepSeek API: ${DEEPSEEK_API_KEY ? '已配置' : '未配置 - 请设置DEEPSEEK_API_KEY环境变量'}`);
  console.log(`=========================================`);
});
// ==UserScript==
// @name         Translate the GitHub interface into Chinese
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.2
// @description  Replaces GitHub's English menu, tab, button and sidebar labels with Simplified Chinese, leaving code, READMEs, issue titles and file names untouched.
// @match        https://github.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/github/translate-interface.user.js
// @updateURL    https://usermods.kennethballenegger.com/github/translate-interface.user.js
// ==/UserScript==

// A text node is translated only when its whole trimmed text is a known interface label,
// so sentences in user content are never touched by accident. Anything inside the
// containers in SKIP (READMEs, code, file names, commit messages, issue and PR titles,
// form fields) is left alone even when it matches.
const WORDS = {
  // Header and global navigation
  'Skip to content': '跳至内容', 'Navigation Menu': '导航菜单', 'Search': '搜索', 'Sign in': '登录',
  'Sign up': '注册', 'Product': '产品', 'Products': '产品', 'Platform': '平台', 'Solutions': '解决方案',
  'Resources': '资源', 'Open Source': '开源', 'Open source': '开源', 'Enterprise': '企业', 'Pricing': '价格',
  'Explore': '探索', 'Learn': '学习', 'Developers': '开发者', 'Documentation': '文档', 'Training': '培训',
  'Certifications': '认证', 'Integrations': '集成', 'Trending repos': '热门仓库', 'Changelog': '更新日志',
  'Businesses': '企业', 'Enterprises': '大型企业', 'Team': '团队', 'Startups': '初创公司', 'Nonprofits': '非营利组织',
  'Healthcare': '医疗', 'Financial services': '金融服务', 'Manufacturing': '制造业', 'Government': '政府',
  'Blog': '博客', 'Community Forum': '社区论坛', 'Support': '支持', 'Customer support': '客户支持',
  'Company': '公司', 'About': '关于', 'Partners': '合作伙伴', 'Codespaces': '代码空间', 'Code Security': '代码安全',
  'Secret Protection': '密钥保护', 'Code Quality': '代码质量', 'All Features': '所有功能', 'Premium Support': '高级支持',
  'Resource center': '资源中心', 'Events & webinars': '活动与网络研讨会', 'Customer Stories': '客户案例',
  'Why GitHub': '为什么选择 GitHub', 'Trust Center': '信任中心', 'Add-ons': '附加组件', 'Dashboard': '仪表板',
  // Repository header and tabs
  'Repository navigation': '仓库导航', 'Code': '代码', 'Issues': '议题', 'Pull requests': '拉取请求',
  'Actions': '操作', 'Projects': '项目', 'Wiki': '维基', 'Security': '安全', 'Security and quality': '安全与质量',
  'Insights': '洞察', 'Settings': '设置', 'Discussions': '讨论', 'Public': '公开', 'Private': '私有',
  'Notifications': '通知', 'Fork': '复刻', 'Star': '星标', 'Starred': '已加星标', 'Unstar': '取消星标',
  'Watch': '关注', 'Unwatch': '取消关注', 'Sponsor': '赞助',
  // File browser
  'Branch': '分支', 'Branches': '分支', 'Tags': '标签', 'tags': '个标签', 'History': '历史',
  'Latest commit': '最新提交', 'Go to file': '转到文件', 'Add file': '添加文件', 'Name': '名称',
  'Last commit message': '最后提交信息', 'Last commit date': '最后提交日期', 'Folders and files': '文件夹和文件',
  'Repository files navigation': '仓库文件导航', 'Raw': '原始', 'Blame': '追溯', 'Preview': '预览',
  'Copy path': '复制路径', 'Top': '顶部', 'Symbols': '符号', 'Files': '文件', 'Outline': '大纲',
  // Sidebar
  'Readme': '自述文件', 'README': '自述文件', 'License': '许可证', 'Activity': '动态', 'Stars': '星标',
  'stars': '星标', 'Watchers': '关注者', 'watching': '人关注', 'Forks': '复刻', 'forks': '复刻',
  'Report repository': '举报仓库', 'Releases': '发行版', 'Packages': '软件包', 'Contributors': '贡献者',
  'Languages': '语言', 'Used by': '使用者', 'Deployments': '部署', 'No releases published': '未发布任何版本',
  'No packages published': '未发布任何软件包', 'Latest': '最新',
  // Issue and pull request lists
  'Open': '打开', 'Closed': '已关闭', 'Merged': '已合并', 'Draft': '草稿', 'Labels': '标签',
  'Milestones': '里程碑', 'Author': '作者', 'Assignee': '受理人', 'Assignees': '受理人', 'Reviews': '审查',
  'Sort': '排序', 'Sort by': '排序方式', 'Filter': '筛选', 'Filters': '筛选', 'New issue': '新建议题',
  'New pull request': '新建拉取请求', 'Newest': '最新', 'Oldest': '最早', 'Type': '类型',
  'Comments': '评论', 'Reviewers': '审查者', 'Participants': '参与者', 'Development': '开发',
  // Footer
  'Footer': '页脚', 'Footer navigation': '页脚导航', 'Terms': '条款', 'Privacy': '隐私', 'Status': '状态',
  'Community': '社区', 'Docs': '文档', 'Contact': '联系我们', 'Manage cookies': '管理 Cookie',
  'Do not share my personal information': '不要共享我的个人信息',
};

// Labels with a number in them.
const PATTERNS = [
  [/^([\d,]+) Commits?$/, '$1 次提交'],
  [/^([\d,]+) Open$/, '$1 个打开'],
  [/^([\d,]+) Closed$/, '$1 个已关闭'],
  [/^\+ ([\d,]+) contributors$/, '另外 $1 位贡献者'],
  [/^\+ ([\d,]+) releases$/, '另外 $1 个发行版'],
];

const SKIP = [
  'script', 'style', 'pre', 'code', 'textarea', 'input', '[contenteditable]',
  '.markdown-body', '.markdown-title', '.react-code-lines', '.blob-code',
  '.react-directory-filename-column', '.react-directory-commit-message', '[data-testid="latest-commit"]',
  'li[role="treeitem"]', '.PRIVATE_TreeView-item-content-text', '[data-testid="breadcrumbs"]',
  '[data-testid="breadcrumbs-filename"]', '[id^="repos-header-breadcrumb"]', '[id^="file-name-id"]',
  '[data-testid="listitem-title-link"]', '[data-testid="issue-title"]', '.js-issue-title',
].join(',');

function translateText(value) {
  const text = value.trim();
  if (!text) return null;
  let out = WORDS[text];
  if (out === undefined) {
    for (const [re, rep] of PATTERNS) {
      if (re.test(text)) { out = text.replace(re, rep); break; }
    }
  }
  return out === undefined ? null : value.replace(text, out);
}

function translateNode(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP)) return;
  const out = translateText(node.nodeValue);
  if (out !== null && out !== node.nodeValue) node.nodeValue = out;
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) { translateNode(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) translateNode(n);
}

// GitHub renders server-side, then hydrates and navigates in place (Turbo and React), so
// every added node and every text change is looked at again.
new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === 'characterData') translateNode(r.target);
    else for (const n of r.addedNodes) translateTree(n);
  }
}).observe(document, { childList: true, subtree: true, characterData: true });

document.addEventListener('DOMContentLoaded', () => translateTree(document.body));

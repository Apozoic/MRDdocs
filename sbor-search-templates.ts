// app\src\app\admin\mrd\sentiens-fiction\projects\[id]\sbor\sbor-search-templates.ts
export type SearchTemplate = { query: string; icon: string }

const PROGRAM_EN: Record<string, string> = {
  'Бизнес': 'Business',
  'Менеджмент': 'Management',
  'Маркетинг': 'Marketing',
  'Финансы': 'Finance',
  'Экономика': 'Economics',
  'Гостеприимство': 'Hospitality',
  'Гостеприимство и туризм': 'Hospitality and Tourism',
  'IT': 'IT and computing',
  'Инженерия': 'Engineering',
  'Архитектура': 'Architecture',
  'Мода': 'Fashion',
  'Арт и дизайн': 'Art and Design',
  'Юриспруденция': 'Law',
  'Международные отношения': 'Politics and International Relations',
  'Психология': 'Psychology',
  'Медиа': 'Media amd journalism',
}

export function getProgramTemplates(name: string): SearchTemplate[] {
  const en = PROGRAM_EN[name]
  if (!en) return []
  return [
    { query: `why ${en}`, icon: 'HelpCircle' },
    { query: `${en} subject area`, icon: 'BookOpen' },
    { query: `${en} (school|faculty)`, icon: 'School' },
  ]
}

const EXCLUDE_ACADEMIC = '-intitle:institute -intitle:school -intitle:department -intitle:faculty'

export const SEARCH_TEMPLATES: Record<string, SearchTemplate[]> = {
  'Почему': [
    { query: 'why {name}', icon: 'HelpCircle' },
    { query: 'reasons to study in {name}', icon: 'ListChecks' },
  ],
  'Об университете': [
    { query: 'about {name}', icon: 'Info' },
    { query: '{name} history -intitle:degree -intitle:course -intitle:courses -intitle:MA -intitle:BA -intitle:phd', icon: 'BookOpen' },
  ],
  'Расположение': [
    { query: 'location -inurl:news', icon: 'MapPin' },
    { query: 'city {shortName} -inurl:news', icon: 'Building2' },
  ],
  'Кампус': [
    { query: 'our campus', icon: 'School' },
  ],
  'Инфраструктура': [
    { query: '(university|campus) facilities -intitle:department -intitle:faculty', icon: 'Wrench' },
  ],
  'Структура': [
    { query: '("schools"|"faculties"|"departments"|"colleges") -inurl:news', icon: 'School' },
  ],
  'Акад. предложение': [
    { query: '(subjects areas|browse subjects) -inurl:news', icon: 'BookOpen' },
    { query: 'study at courses and programmes -intitle:school -intitle:faculty -intitle:department -inurl:news', icon: 'GraduationCap' },
  ],
  'Студенческая жизнь': [
    { query: 'student life university -inurl:news', icon: 'Users' },
    { query: 'societies and clubs -inurl:news', icon: 'UsersRound' },
    { query: 'sport clubs -inurl:news', icon: 'Trophy' },
  ],
  'Проживание': [
    { query: 'about university accommodation -inurl:news', icon: 'BedDouble' },
  ],
  'Аккредитации': [
    { query: 'accreditations', icon: 'BadgeCheck' },
  ],
  'Рейтинг': [
    { query: 'rankings', icon: 'TrendingUp' },
  ],
  'Достижения': [
    { query: '(facts|figures) about {name}', icon: 'BarChart2' },
    { query: '{name} achievements', icon: 'Medal' },
    { query: 'university (named|received|wins) award -inurl:alumni -intitle:alumni -intitle:Dr -intitle:professor -intitle:student', icon: 'Award' },
  ],
  'Знаменитые выпускники': [
    { query: '("notable"|"famous") alumni', icon: 'Star' },
  ],
  'Карьера': [
    { query: `partners ${EXCLUDE_ACADEMIC}`, icon: 'Handshake' },
    { query: `career opportunities ${EXCLUDE_ACADEMIC} -inurl:news`, icon: 'Briefcase' },
    { query: `industry companies ${EXCLUDE_ACADEMIC}`, icon: 'Factory' },
    { query: `placement companies -intitle:institute -intitle:school -intitle:department -intitle:faculty -intitle:with -intitle:BSc`, icon: 'Target' },
  ],
  'Международность': [
    { query: 'international students', icon: 'Globe' },
  ],
}

export const GLOBAL_EXCLUDE = '-inurl:blog -inurl:tag -inurl:stories -inurl:events -filetype:pdf -filetype:doc -filetype:docx'

function shortenName(name: string): string {
  return name
    .replace(/\bthe\b/gi, '')
    .replace(/\buniversity of\b/gi, '')
    .replace(/\buniversity\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function applyTemplate(query: string, projectName?: string): string {
  const name = projectName ?? ''
  return query
    .replace(/\{shortName\}/g, shortenName(name))
    .replace(/\{name\}/g, name)
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildGoogleUrl(siteUrl: string, query: string): string {
  const tail = `${query} ${GLOBAL_EXCLUDE}`
  try {
    const domain = new URL(siteUrl).hostname.replace(/^www\./, '')
    return `https://www.google.com/search?q=site:${domain}+${encodeURIComponent(tail)}`
  } catch {
    return `https://www.google.com/search?q=${encodeURIComponent(tail)}`
  }
}

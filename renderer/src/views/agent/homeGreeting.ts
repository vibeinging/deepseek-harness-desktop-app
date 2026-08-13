export type HomeGreetingPeriod = 'late' | 'morning' | 'afternoon' | 'evening'

export interface HomeGreeting {
  period: HomeGreetingPeriod
  title: string
  subtitle: string
}

const HOME_GREETINGS: Record<HomeGreetingPeriod, HomeGreeting> = {
  late: {
    period: 'late',
    title: '这么晚了还要工作呀？',
    subtitle: '别太勉强，我陪你把这件事做完。'
  },
  morning: {
    period: 'morning',
    title: '上午好，今天做点什么？',
    subtitle: '我已经准备好啦，随时可以开始。'
  },
  afternoon: {
    period: 'afternoon',
    title: '下午好，接下来做点什么？',
    subtitle: '交给我吧，我们继续往前推进。'
  },
  evening: {
    period: 'evening',
    title: '晚上好，还要继续吗？',
    subtitle: '辛苦啦，剩下的事情一起完成吧。'
  }
}

/** Resolves the homepage character's line from the renderer's local time. */
export function resolveHomeGreeting(at: Date = new Date()): HomeGreeting {
  const hour = at.getHours()
  if (hour < 5 || hour >= 23) return HOME_GREETINGS.late
  if (hour < 12) return HOME_GREETINGS.morning
  if (hour < 18) return HOME_GREETINGS.afternoon
  return HOME_GREETINGS.evening
}

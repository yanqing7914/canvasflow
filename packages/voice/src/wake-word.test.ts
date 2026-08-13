import { describe, expect, it } from 'vitest'
import { matchWakeWord } from './wake-word'

describe('wake word matching', () => {
  it('accepts canonical and conservative aliases only at the start', () => {
    expect(matchWakeWord('小南，我要去机场接人')).toMatchObject({ matched: true, command: '我要去机场接人', alias: '小南' })
    expect(matchWakeWord('小楠 查天气')).toMatchObject({ matched: true, command: '查天气', alias: '小楠' })
    expect(matchWakeWord('晓南，跑快点')).toMatchObject({ matched: true, command: '跑快点', alias: '晓南' })
    expect(matchWakeWord('笑男')).toMatchObject({ matched: true, command: '', alias: '笑男' })
    expect(matchWakeWord('小南查天气')).toMatchObject({ matched: true, command: '查天气', alias: '小南' })
    expect(matchWakeWord('小蓝')).toMatchObject({ matched: true, command: '', alias: '小蓝' })
    expect(matchWakeWord('小南门')).toMatchObject({ matched: false })
    expect(matchWakeWord('我看到小南')).toMatchObject({ matched: false })
  })

  it('allows a polite greeting and strips punctuation around the command', () => {
    expect(matchWakeWord('你好，小南：重新开始')).toMatchObject({ matched: true, command: '重新开始' })
  })

  it('accepts Chrome transliterations of Xiaonan at the start of an utterance', () => {
    expect(matchWakeWord('xiao n')).toMatchObject({ matched: true, alias: '小南', command: '' })
    expect(matchWakeWord('xiao nan，查天气')).toMatchObject({ matched: true, alias: '小南', command: '查天气' })
    expect(matchWakeWord('xiaonan 开始导航')).toMatchObject({ matched: true, alias: '小南', command: '开始导航' })
    expect(matchWakeWord('xiao n 查天气')).toMatchObject({ matched: true, alias: '小南', command: '查天气' })
    expect(matchWakeWord('小 南，查天气')).toMatchObject({ matched: true, alias: '小南', command: '查天气' })
    expect(matchWakeWord('我想 xiao n')).toMatchObject({ matched: false })
    expect(matchWakeWord('xiao n门')).toMatchObject({ matched: false })
  })
})

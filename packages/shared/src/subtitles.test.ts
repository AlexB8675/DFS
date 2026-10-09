import { describe, expect, it } from 'vitest'
import { decodeSubtitles, languageOf, subtitleFileOf, toWebVtt } from './subtitles.ts'

describe('subtitle files beside a video', () => {
  it('belong to the video by its name, whatever the case', () => {
    expect(subtitleFileOf('Film.mkv', 'Film.srt')).toEqual({
      language: null,
      forced: false,
      hearingImpaired: false,
    })
    expect(subtitleFileOf('Film.mkv', 'film.IT.srt')?.language).toBe('it')
    expect(subtitleFileOf('The.Matrix.1999.mkv', 'The.Matrix.1999.eng.srt')?.language).toBe('en')
    for (const name of ['Film 2.srt', 'Filming.srt', 'Film.txt', 'Other.srt', 'Film.mkv']) {
      expect(subtitleFileOf('Film.mkv', name)).toBeNull()
    }
  })

  it('say their language, forced and for the hard of hearing', () => {
    expect(subtitleFileOf('Film.mp4', 'Film.en.forced.vtt')).toEqual({
      language: 'en',
      forced: true,
      hearingImpaired: false,
    })
    expect(subtitleFileOf('Film.mp4', 'Film.pt-BR.sdh.ass')).toEqual({
      language: 'pt-BR',
      forced: false,
      hearingImpaired: true,
    })
    // `hi` is Hindi on its own, and hard of hearing after a language.
    expect(subtitleFileOf('Film.mp4', 'Film.hi.srt')?.language).toBe('hi')
    expect(subtitleFileOf('Film.mp4', 'Film.en.hi.srt')).toEqual({
      language: 'en',
      forced: false,
      hearingImpaired: true,
    })
  })

  it('read languages from codes of two or three letters and English names', () => {
    expect(languageOf('ita')).toBe('it')
    expect(languageOf('ger')).toBe('de')
    expect(languageOf('pt_BR')).toBe('pt-BR')
    expect(languageOf('Italian')).toBe('it')
    expect(languageOf('english')).toBe('en')
    for (const word of ['x264', 'final', 'cc', 'qq']) expect(languageOf(word)).toBeNull()
  })
})

describe('decoding subtitle files', () => {
  it('reads UTF-8, and UTF-16 by its byte-order mark', () => {
    expect(decodeSubtitles(new TextEncoder().encode('Perché'), null)).toBe('Perché')
    const utf16 = new Uint8Array([0xff, 0xfe, 0x50, 0x00, 0xe9, 0x00])
    expect(decodeSubtitles(utf16, null)).toBe('Pé')
  })

  it('reads a file that isn’t UTF-8 in its language’s Windows encoding', () => {
    // "Привет" in windows-1251, and "Perché" in windows-1252.
    const russian = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])
    expect(decodeSubtitles(russian, 'ru')).toBe('Привет')
    const italian = new Uint8Array([0x50, 0x65, 0x72, 0x63, 0x68, 0xe9])
    expect(decodeSubtitles(italian, null)).toBe('Perché')
  })
})

describe('SRT as WebVTT', () => {
  it('converts times and text, keeping italics and escaping the rest', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,500',
      '<i>Hello</i> & <font color="#fff">goodbye</font>',
      '',
      '2',
      '00:01:02,05 --> 00:01:03,000',
      'a < b --> c',
      '',
    ].join('\r\n')
    expect(toWebVtt(srt, 'srt')).toBe(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:02.500',
        '<i>Hello</i> &amp; goodbye',
        '',
        '00:01:02.050 --> 00:01:03.000',
        'a &lt; b --&gt; c',
        '',
      ].join('\n'),
    )
  })

  it('takes cues with no blank line between them, and puts {\\an8} at the top', () => {
    const srt = [
      '﻿1',
      '0:00:01.000 --> 0:00:02.000',
      '{\\an8}Up here',
      '2',
      '00:00:03,000 --> 00:00:04,000',
      'Two lines,',
      'one cue.',
      '3',
      '00:00:05,000 --> 00:00:05,000',
      'No time at all',
    ].join('\n')
    expect(toWebVtt(srt, 'srt')).toBe(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:02.000 line:0',
        'Up here',
        '',
        '00:00:03.000 --> 00:00:04.000',
        'Two lines,',
        'one cue.',
        '',
      ].join('\n'),
    )
  })
})

describe('ASS as WebVTT', () => {
  it('converts dialogue in time order, with its markup and line breaks', () => {
    const ass = [
      '[Script Info]',
      'Title: Test',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Second, with a comma',
      'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Not shown',
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hello{\\i0}\\Nthere {\\b1}you{\\fad(200,200)}',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\an8\\bord2}Top\\N\\N',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100',
    ].join('\n')
    expect(toWebVtt(ass, 'ass')).toBe(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:02.500',
        '<i>Hello</i>',
        'there <b>you</b>',
        '',
        '00:00:03.000 --> 00:00:04.000 line:0',
        'Top',
        '',
        '00:00:05.000 --> 00:00:06.000',
        'Second, with a comma',
        '',
      ].join('\n'),
    )
  })
})

describe('WebVTT', () => {
  it('stays as it is but for its line endings, and one without its header is read as SRT', () => {
    expect(toWebVtt('WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\n<c.yellow>Hi</c>', 'vtt')).toBe(
      'WEBVTT\n\n00:01.000 --> 00:02.000\n<c.yellow>Hi</c>\n',
    )
    expect(toWebVtt('1\n00:00:01,000 --> 00:00:02,000\nHi\n', 'vtt')).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n',
    )
  })
})

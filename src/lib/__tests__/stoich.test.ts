import { describe, it, expect } from 'vitest'
import { Fraction } from '../fraction'
import {
  computeStoich,
  compareFraction,
  formatFraction,
  parseDecimal,
  type StoichInput,
  type StoichSpecies,
} from '../stoich'

function mkSpecies(): StoichSpecies[] {
  // 2H2 + O2 -> 2H2O
  return [
    { id: 1, side: 'left', label: 'H2', coefficient: 2n },
    { id: 2, side: 'left', label: 'O2', coefficient: 1n },
    { id: 3, side: 'right', label: 'H2O', coefficient: 2n },
  ]
}

function mkInputs(map: Record<number, Partial<StoichInput>>): Map<number, StoichInput> {
  const m = new Map<number, StoichInput>()
  for (const [k, v] of Object.entries(map)) {
    m.set(Number(k), { amount: '', unit: 'mol', molarMass: '', ...v })
  }
  return m
}

describe('parseDecimal', () => {
  it('解析普通十进制数为精确分数', () => {
    expect(parseDecimal('1.5').value).toEqual(new Fraction(3n, 2n))
    expect(parseDecimal('0.001').value).toEqual(new Fraction(1n, 1000n))
    expect(parseDecimal('2').value).toEqual(new Fraction(2n))
  })

  it('空值与非法文本报错而不是当作 0', () => {
    expect(parseDecimal('').error).toBeTruthy()
    expect(parseDecimal('  ').error).toBeTruthy()
    expect(parseDecimal('abc').error).toBeTruthy()
    expect(parseDecimal('1.2.3').error).toBeTruthy()
    expect(parseDecimal('1e3').error).toBeTruthy()
  })
})

describe('computeStoich', () => {
  it('氧气过量时氢气为限量试剂', () => {
    const r = computeStoich(
      mkSpecies(),
      mkInputs({ 1: { amount: '2' }, 2: { amount: '3' }, 3: {} }),
    )
    expect(r.hasError).toBe(false)
    expect(r.limiting).toEqual([0])
    const [h2, o2, h2o] = r.entries
    expect(h2.remaining).toEqual(new Fraction(0n))
    expect(o2.consumed).toEqual(new Fraction(1n))
    expect(o2.remaining).toEqual(new Fraction(2n))
    expect(h2o.produced).toEqual(new Fraction(2n))
  })

  it('恰好配比时全部反应物并列限量、剩余为 0', () => {
    const r = computeStoich(
      mkSpecies(),
      mkInputs({ 1: { amount: '2' }, 2: { amount: '1' }, 3: {} }),
    )
    expect(r.limiting).toEqual([0, 1])
    expect(r.entries[0].remaining!.isZero()).toBe(true)
    expect(r.entries[1].remaining!.isZero()).toBe(true)
  })

  it('并列限量由精确分数判定，近似小数不会伪造并列', () => {
    // H2: 0.666666 mol / 2 = 0.333333；O2: 1/3 mol / 1 = 1/3，二者接近但不相等
    const r = computeStoich(
      mkSpecies(),
      mkInputs({ 1: { amount: '0.666666' }, 2: { amount: '0.333333333333333333' }, 3: {} }),
    )
    expect(r.limiting).toEqual([0])
    // 剩余量不为负
    expect(r.entries[1].remaining!.isNegative()).toBe(false)
  })

  it('mmol 与 g 单位正确换算，质量按各自摩尔质量计算', () => {
    const r = computeStoich(
      mkSpecies(),
      mkInputs({
        1: { amount: '2000', unit: 'mmol' },
        2: { amount: '32', unit: 'g', molarMass: '32' },
        3: { molarMass: '18' },
      }),
    )
    expect(r.hasError).toBe(false)
    expect(r.entries[0].mol).toEqual(new Fraction(2n))
    expect(r.entries[1].mol).toEqual(new Fraction(1n))
    expect(r.limiting).toEqual([0, 1])
    expect(r.entries[2].produced).toEqual(new Fraction(2n))
    expect(r.entries[2].mass).toEqual(new Fraction(36n))
  })

  it('g 投料缺少摩尔质量时报字段错误', () => {
    const r = computeStoich(
      mkSpecies(),
      mkInputs({ 1: { amount: '2' }, 2: { amount: '16', unit: 'g' }, 3: {} }),
    )
    expect(r.hasError).toBe(true)
    expect(r.entries[1].errors.some((e) => e.field === 'molarMass')).toBe(true)
  })

  it('空值、负数、非法文本分别定位提示', () => {
    const r = computeStoich(
      mkSpecies(),
      mkInputs({ 1: { amount: '' }, 2: { amount: '-1' }, 3: { molarMass: 'abc' } }),
    )
    expect(r.hasError).toBe(true)
    expect(r.entries[0].errors[0].message).toContain('不能为空')
    expect(r.entries[1].errors[0].message).toContain('负数')
    expect(r.entries[2].errors[0].field).toBe('molarMass')
  })

  it('摩尔质量必须为正数', () => {
    const r = computeStoich(
      mkSpecies(),
      mkInputs({ 1: { amount: '2' }, 2: { amount: '1', molarMass: '0' }, 3: {} }),
    )
    expect(r.hasError).toBe(true)
    expect(r.entries[1].errors[0].message).toContain('正数')
  })
})

describe('formatFraction', () => {
  it('整数与有限小数精确显示', () => {
    expect(formatFraction(new Fraction(3n))).toEqual({ text: '3', approx: false })
    expect(formatFraction(new Fraction(1n, 4n))).toEqual({ text: '0.25', approx: false })
  })

  it('无限循环小数舍入并标注 ≈', () => {
    const f = formatFraction(new Fraction(1n, 3n))
    expect(f.approx).toBe(true)
    expect(f.text).toContain('≈')
    expect(f.text).toContain('0.333333')
  })
})

describe('compareFraction', () => {
  it('精确比较', () => {
    expect(compareFraction(new Fraction(1n, 3n), new Fraction(333333n, 1000000n))).toBe(1)
    expect(compareFraction(new Fraction(1n, 2n), new Fraction(2n, 4n))).toBe(0)
  })
})

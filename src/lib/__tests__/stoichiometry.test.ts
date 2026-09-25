import { describe, it, expect } from 'vitest'
import {
  parseDecimal,
  validateDosing,
  computeDosing,
  formatFraction,
  isExactDecimal,
  emptyDosingInput,
  type DosingSpecies,
} from '../stoichiometry'
import { Fraction } from '../fraction'

function sp(
  side: 'left' | 'right',
  coefficient: bigint,
  amountText = '',
  unit: 'mol' | 'mmol' | 'g' = 'mol',
  molarMassText = '',
): DosingSpecies {
  return { side, coefficient, amountText, unit, molarMassText }
}

describe('parseDecimal', () => {
  it('接受普通十进制数', () => {
    for (const t of ['2', '0.5', '1.25', '.5', '0']) {
      const r = parseDecimal(t, { allowZero: true })
      expect(r.ok, t).toBe(true)
    }
    const r = parseDecimal('1.25', { allowZero: true })
    expect(r.ok && r.value.num === 5n && r.value.den === 4n).toBe(true)
  })

  it('拒绝空值、负数与非法文本', () => {
    for (const t of ['', '   ', '-1', '−2', 'abc', '1e3', '1,5', '1..2', '--1']) {
      const r = parseDecimal(t, { allowZero: true })
      expect(r.ok, JSON.stringify(t)).toBe(false)
    }
  })

  it('摩尔质量不允许为 0', () => {
    expect(parseDecimal('0', { allowZero: false }).ok).toBe(false)
    expect(parseDecimal('0.5', { allowZero: false }).ok).toBe(true)
  })
})

describe('validateDosing', () => {
  it('空数量、负数、非法文本都定位到字段', () => {
    const errs = validateDosing([sp('left', 1n, ''), sp('left', 1n, '-3'), sp('left', 1n, 'xy')])
    expect(errs).toHaveLength(3)
    expect(errs.every((e) => e.field === 'amount')).toBe(true)
    expect(errs.map((e) => e.index)).toEqual([0, 1, 2])
  })

  it('g 单位缺少摩尔质量时报错', () => {
    const errs = validateDosing([sp('left', 1n, '4', 'g', '')])
    expect(errs).toHaveLength(1)
    expect(errs[0].field).toBe('molarMass')
  })

  it('生成物不填数量不报错，摩尔质量非法时报错', () => {
    expect(validateDosing([sp('right', 1n)])).toHaveLength(0)
    const errs = validateDosing([sp('right', 1n, '', 'mol', 'abc')])
    expect(errs).toHaveLength(1)
    expect(errs[0].field).toBe('molarMass')
  })
})

describe('computeDosing', () => {
  // 2 H2 + O2 -> 2 H2O
  const h2 = (amount: string, unit: 'mol' | 'mmol' | 'g' = 'mol', mm = '') =>
    sp('left', 2n, amount, unit, mm)
  const o2 = (amount: string, unit: 'mol' | 'mmol' | 'g' = 'mol', mm = '') =>
    sp('left', 1n, amount, unit, mm)
  const h2o = (mm = '') => sp('right', 2n, '', 'mol', mm)

  it('单一限量试剂：消耗、剩余与产量', () => {
    const out = computeDosing([h2('2'), o2('2'), h2o('18')])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const r = out.result
    expect(r.extent.num === 1n && r.extent.den === 1n).toBe(true)
    expect(r.limiting).toEqual([0])
    expect(r.reactants[0].remainingMol.isZero()).toBe(true)
    expect(r.reactants[1].remainingMol.num === 1n).toBe(true)
    expect(r.products[0].producedMol.num === 2n).toBe(true)
    expect(r.products[0].producedG!.num === 36n).toBe(true)
  })

  it('恰好配比时全部反应物并列限量且剩余精确为 0', () => {
    const out = computeDosing([h2('2'), o2('1'), h2o()])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.limiting).toEqual([0, 1])
    for (const line of out.result.reactants) expect(line.remainingMol.isZero()).toBe(true)
  })

  it('g 与 mmol 单位正确换算', () => {
    const out = computeDosing([h2('4', 'g', '2'), o2('500', 'mmol'), h2o()])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // H2: 4g / 2(g/mol) = 2 mol, ratio 1；O2: 0.5 mol, ratio 0.5 → O2 限量
    expect(out.result.limiting).toEqual([1])
    expect(out.result.extent.den === 2n && out.result.extent.num === 1n).toBe(true)
    expect(out.result.reactants[0].remainingMol.num === 1n).toBe(true)
  })

  it('精确有理数比较：近似小数不会制造并列', () => {
    // 反应物 A 系数 3 投 1 mol（比值 1/3），B 系数 1 投 0.333333 mol（比值略小）
    const out = computeDosing([sp('left', 3n, '1'), sp('left', 1n, '0.333333'), sp('right', 1n)])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.limiting).toEqual([1])
    // A 剩余 = 1 - 3*0.333333 = 0.000001 mol，精确为正
    expect(out.result.reactants[0].remainingMol.isPositive()).toBe(true)
    expect(out.result.reactants[0].remainingMol.num === 1n).toBe(true)
    expect(out.result.reactants[0].remainingMol.den === 1000000n).toBe(true)
  })

  it('未填摩尔质量的生成物只给物质的量', () => {
    const out = computeDosing([h2('2'), o2('1'), h2o()])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.products[0].producedG).toBeNull()
    expect(out.result.products[0].producedMol.num === 2n).toBe(true)
  })

  it('存在非法输入时不计算', () => {
    const out = computeDosing([h2(''), o2('1'), h2o()])
    expect(out.ok).toBe(false)
  })
})

describe('formatFraction / isExactDecimal', () => {
  it('整数与有限小数精确显示', () => {
    expect(formatFraction(new Fraction(3n))).toBe('3')
    expect(formatFraction(new Fraction(5n, 4n))).toBe('1.25')
    expect(isExactDecimal(new Fraction(5n, 4n))).toBe(true)
  })

  it('无限循环小数舍入并标记为近似', () => {
    expect(formatFraction(new Fraction(1n, 3n))).toBe('0.333333')
    expect(isExactDecimal(new Fraction(1n, 3n))).toBe(false)
    expect(formatFraction(new Fraction(2n, 3n))).toBe('0.666667')
  })

  it('极小正值显示为下界而非 0', () => {
    expect(formatFraction(new Fraction(1n, 10000000n))).toBe('< 0.000001')
  })

  it('emptyDosingInput 默认为 mol 且为空', () => {
    const e = emptyDosingInput()
    expect(e.amountText).toBe('')
    expect(e.unit).toBe('mol')
    expect(e.molarMassText).toBe('')
  })
})

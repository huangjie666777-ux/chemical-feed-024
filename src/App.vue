<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { parseFormula, type ParseResult } from './lib/parser'
import { balance, type BalanceResult, type Species } from './lib/solver'
import {
  computeDosing,
  emptyDosingInput,
  formatFraction,
  isExactDecimal,
  validateDosing,
  type DosingResult,
  type DosingSpecies,
  type SpeciesDosingInput,
} from './lib/stoichiometry'

interface Row {
  id: number
  text: string
}

let nextId = 1
const mkRows = (texts: string[]): Row[] => texts.map((text) => ({ id: nextId++, text }))

const leftRows = reactive<Row[]>(mkRows(['H2', 'O2']))
const rightRows = reactive<Row[]>(mkRows(['H2O']))

const EXAMPLES: Array<{ name: string; left: string[]; right: string[] }> = [
  {
    name: '普通反应（甲烷燃烧）',
    left: ['CH4', 'O2'],
    right: ['CO2', 'H2O'],
  },
  {
    name: '嵌套分组（亚铁氰化镁与氢氧化钾）',
    left: ['Mg2[Fe(CN)6]', 'KOH'],
    right: ['Mg(OH)2', 'K4[Fe(CN)6]'],
  },
  {
    name: '结晶水（五水硫酸铜脱水）',
    left: ['CuSO4·5H2O'],
    right: ['CuSO4', 'H2O'],
  },
  {
    name: '离子-电子反应（高锰酸根还原）',
    left: ['MnO4^-', 'H^+', 'e^-'],
    right: ['Mn^2+', 'H2O'],
  },
]

interface Snapshot {
  rows: { id: number; side: 'left' | 'right'; text: string }[]
  result: BalanceResult
  elementOrder: string[]
}

const snapshot = ref<Snapshot | null>(null)
const dirty = ref(false)
/** 增删物质或修改化学式时 +1，使所有投料方案的旧结果失效 */
const equationVersion = ref(0)
const highlightedElement = ref<string | null>(null)
const copyState = ref<'idle' | 'ok' | 'fail'>('idle')
const globalMessage = ref('')

interface RowParse {
  result: ParseResult
}

function parseRow(text: string): RowParse {
  return { result: parseFormula(text) }
}

const leftParsed = computed(() => leftRows.map((r) => ({ row: r, ...parseRow(r.text) })))
const rightParsed = computed(() => rightRows.map((r) => ({ row: r, ...parseRow(r.text) })))

const parseErrors = computed(() => {
  const errs: { side: 'left' | 'right'; id: number; text: string; message: string; pos: number }[] = []
  for (const p of leftParsed.value) {
    if (p.row.text.trim() !== '' && !p.result.ok) {
      errs.push({
        side: 'left',
        id: p.row.id,
        text: p.row.text,
        message: p.result.error.message,
        pos: p.result.error.pos,
      })
    }
  }
  for (const p of rightParsed.value) {
    if (p.row.text.trim() !== '' && !p.result.ok) {
      errs.push({
        side: 'right',
        id: p.row.id,
        text: p.row.text,
        message: p.result.error.message,
        pos: p.result.error.pos,
      })
    }
  }
  return errs
})

const canBalance = computed(
  () =>
    leftRows.some((r) => r.text.trim() !== '') &&
    rightRows.some((r) => r.text.trim() !== '') &&
    parseErrors.value.length === 0,
)

function addRow(side: 'left' | 'right') {
  const rows = side === 'left' ? leftRows : rightRows
  rows.push({ id: nextId++, text: '' })
  dirty.value = true
  equationVersion.value++
}

function removeRow(side: 'left' | 'right', id: number) {
  const rows = side === 'left' ? leftRows : rightRows
  const idx = rows.findIndex((r) => r.id === id)
  if (idx >= 0) rows.splice(idx, 1)
  dirty.value = true
  equationVersion.value++
}

function moveRow(side: 'left' | 'right', id: number, delta: -1 | 1) {
  const rows = side === 'left' ? leftRows : rightRows
  const idx = rows.findIndex((r) => r.id === id)
  const target = idx + delta
  if (idx < 0 || target < 0 || target >= rows.length) return
  const [item] = rows.splice(idx, 1)
  rows.splice(target, 0, item)
  dirty.value = true
}

function onInput() {
  dirty.value = true
  equationVersion.value++
}

function doBalance() {
  if (!canBalance.value) return
  const species: Species[] = []
  const rowsSnapshot: Snapshot['rows'] = []
  for (const p of leftParsed.value) {
    if (p.row.text.trim() === '' || !p.result.ok) continue
    species.push({ raw: p.row.text.trim(), formula: p.result.formula!, side: 'left' })
    rowsSnapshot.push({ id: p.row.id, side: 'left', text: p.row.text })
  }
  for (const p of rightParsed.value) {
    if (p.row.text.trim() === '' || !p.result.ok) continue
    species.push({ raw: p.row.text.trim(), formula: p.result.formula!, side: 'right' })
    rowsSnapshot.push({ id: p.row.id, side: 'right', text: p.row.text })
  }
  const result = balance(species)
  const elementOrder: string[] = []
  const seen = new Set<string>()
  for (const sp of species) {
    for (const el of Object.keys(sp.formula.elements)) {
      if (!seen.has(el)) {
        seen.add(el)
        elementOrder.push(el)
      }
    }
  }
  snapshot.value = { rows: rowsSnapshot, result, elementOrder }
  dirty.value = false
  highlightedElement.value = null
  globalMessage.value = ''
}

function loadExample(ex: (typeof EXAMPLES)[number]) {
  leftRows.splice(0, leftRows.length, ...mkRows(ex.left))
  rightRows.splice(0, rightRows.length, ...mkRows(ex.right))
  dirty.value = true
  globalMessage.value = `已载入示例：${ex.name}，点击「配平」查看结果。`
}

const stale = computed(() => dirty.value || parseErrors.value.length > 0)

const equationText = computed(() => {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return ''
  const coef = snap.result.coefficients
  const parts = snap.rows.map((r, i) => {
    const c = coef[i]
    return c === 1n ? r.text : `${c}${r.text.replace(/\s+/g, '')}`
  })
  const left = parts
    .filter((_, i) => snap.rows[i].side === 'left')
    .join(' + ')
  const right = parts
    .filter((_, i) => snap.rows[i].side === 'right')
    .join(' + ')
  return `${left} → ${right}`
})

interface CheckRow {
  label: string
  left: bigint
  right: bigint
  balanced: boolean
}

const checkTable = computed<CheckRow[]>(() => {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return []
  const coef = snap.result.coefficients
  const rows: CheckRow[] = snap.elementOrder.map((el) => {
    let left = 0n
    let right = 0n
    snap.rows.forEach((r, i) => {
      const parsed = parseFormula(r.text)
      if (!parsed.ok) return
      const n = parsed.formula.elements[el] ?? 0n
      if (r.side === 'left') left += n * coef[i]
      else right += n * coef[i]
    })
    return { label: el, left, right, balanced: left === right }
  })
  let leftCharge = 0n
  let rightCharge = 0n
  snap.rows.forEach((r, i) => {
    const parsed = parseFormula(r.text)
    if (!parsed.ok) return
    if (r.side === 'left') leftCharge += parsed.formula.charge * coef[i]
    else rightCharge += parsed.formula.charge * coef[i]
  })
  rows.push({ label: '电荷', left: leftCharge, right: rightCharge, balanced: leftCharge === rightCharge })
  return rows
})

function contribution(text: string, element: string): bigint | null {
  const r = parseFormula(text)
  if (!r.ok) return null
  return r.formula.elements[element] ?? null
}

async function copyEquation() {
  if (!equationText.value) return
  try {
    await navigator.clipboard.writeText(equationText.value)
    copyState.value = 'ok'
  } catch {
    copyState.value = 'fail'
  }
  setTimeout(() => (copyState.value = 'idle'), 2000)
}

function formatCharge(n: bigint): string {
  if (n === 0n) return '0'
  const sign = n > 0n ? '+' : '-'
  const mag = n < 0n ? -n : n
  return mag === 1n ? sign : `${mag}${sign}`
}

function coefFor(side: 'left' | 'right', indexWithinSide: number): bigint | null {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return null
  let globalIdx = 0
  for (let i = 0; i < snap.rows.length; i++) {
    if (snap.rows[i].side === side) {
      if (globalIdx === indexWithinSide) return snap.result.coefficients[i]
      globalIdx++
    }
  }
  return null
}

function onRowKeydown(e: KeyboardEvent, side: 'left' | 'right', id: number, index: number) {
  if (e.key === 'Enter') {
    e.preventDefault()
    const rows = side === 'left' ? leftRows : rightRows
    if (index === rows.length - 1) {
      addRow(side)
      requestAnimationFrame(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>(`[data-side="${side}"] .formula-input`)
        inputs[inputs.length - 1]?.focus()
      })
    } else {
      const inputs = document.querySelectorAll<HTMLInputElement>(`[data-side="${side}"] .formula-input`)
      inputs[index + 1]?.focus()
    }
  } else if (e.key === 'Backspace' && (e.target as HTMLInputElement).value === '' && rowsCount(side) > 1) {
    e.preventDefault()
    removeRow(side, id)
  }
}

function rowsCount(side: 'left' | 'right'): number {
  return (side === 'left' ? leftRows : rightRows).length
}

/* ---------------- 投料方案 ---------------- */

interface Plan {
  id: number
  name: string
  /** 以物质行 id 为键，调序时投料随物质移动 */
  inputs: Record<number, SpeciesDosingInput>
  result: DosingResult | null
  /** 计算时的 equationVersion；不一致说明方程式已改，结果失效 */
  resultVersion: number
}

let nextPlanId = 1
const PLAN_NAMES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function makePlan(name?: string): Plan {
  const id = nextPlanId++
  return {
    id,
    name: name ?? `方案 ${PLAN_NAMES[(id - 1) % PLAN_NAMES.length]}`,
    inputs: {},
    result: null,
    resultVersion: -1,
  }
}

const plans = ref<Plan[]>([makePlan()])
const activePlanId = ref(plans.value[0].id)

const activePlan = computed(() => plans.value.find((p) => p.id === activePlanId.value) ?? plans.value[0])

function inputFor(plan: Plan, rowId: number): SpeciesDosingInput {
  if (!plan.inputs[rowId]) plan.inputs[rowId] = emptyDosingInput()
  return plan.inputs[rowId]
}

function addPlan() {
  const p = makePlan()
  plans.value.push(p)
  activePlanId.value = p.id
}

function duplicatePlan(plan: Plan) {
  const copy = makePlan(`${plan.name} 副本`)
  const inputs: Record<number, SpeciesDosingInput> = {}
  for (const [k, v] of Object.entries(plan.inputs)) inputs[Number(k)] = { ...v }
  copy.inputs = inputs
  plans.value.push(copy)
  activePlanId.value = copy.id
}

function removePlan(plan: Plan) {
  const idx = plans.value.findIndex((p) => p.id === plan.id)
  if (idx < 0) return
  plans.value.splice(idx, 1)
  if (plans.value.length === 0) plans.value.push(makePlan())
  if (activePlanId.value === plan.id) activePlanId.value = plans.value[0].id
}

function onDosingEdit(plan: Plan) {
  plan.result = null
}

const dosingApplicable = computed(() => {
  const snap = snapshot.value
  return !!snap && !stale.value && snap.result.kind === 'unique'
})

const hasElectron = computed(() => {
  const snap = snapshot.value
  if (!snap) return false
  return snap.rows.some((r) => {
    const p = parseFormula(r.text)
    return p.ok && p.formula.isElectron
  })
})

function dosingSpeciesFor(plan: Plan): DosingSpecies[] {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return []
  const coefficients = snap.result.coefficients
  return snap.rows.map((r, i) => {
    const inp = inputFor(plan, r.id)
    return {
      side: r.side,
      coefficient: coefficients[i],
      amountText: inp.amountText,
      unit: inp.unit,
      molarMassText: inp.molarMassText,
    }
  })
}

const activePlanErrors = computed(() => {
  if (!dosingApplicable.value || hasElectron.value) return []
  return validateDosing(dosingSpeciesFor(activePlan.value))
})

function errorFor(rowIndex: number, field: 'amount' | 'molarMass'): string | null {
  const e = activePlanErrors.value.find((e) => e.index === rowIndex && e.field === field)
  return e ? e.message : null
}

function computePlan(plan: Plan) {
  if (!dosingApplicable.value || hasElectron.value) return
  const out = computeDosing(dosingSpeciesFor(plan))
  if (out.ok) {
    plan.result = out.result
    plan.resultVersion = equationVersion.value
  } else {
    plan.result = null
  }
}

function planResultValid(plan: Plan): boolean {
  return plan.result !== null && plan.resultVersion === equationVersion.value && !stale.value
}

const comparablePlans = computed(() => plans.value.filter((p) => planResultValid(p)))

function fillDosingExample(kind: 'stoich' | 'excess') {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return
  const plan = activePlan.value
  let firstLeft = true
  snap.rows.forEach((r, i) => {
    if (r.side !== 'left') return
    const coef = snap.result.kind === 'unique' ? snap.result.coefficients[i] : 1n
    const mult = kind === 'excess' && firstLeft ? 2n : 1n
    firstLeft = false
    const inp = inputFor(plan, r.id)
    inp.amountText = (coef * mult).toString()
    inp.unit = 'mol'
  })
  plan.result = null
  globalMessage.value =
    kind === 'stoich'
      ? `已按配平系数填入「${plan.name}」：各反应物恰好配比。`
      : `已填入「${plan.name}」：第一种反应物加倍（过量），其余按系数配比。`
}

function approx(f: Parameters<typeof isExactDecimal>[0]): string {
  return isExactDecimal(f) ? '' : '≈'
}

function onDosingKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    computePlan(activePlan.value)
  }
}

function coefOf(i: number): bigint | null {
  const snap = snapshot.value
  if (!snap || snap.result.kind !== 'unique') return null
  return snap.result.coefficients[i]
}

function rowText(i: number): string {
  return snapshot.value?.rows[i]?.text ?? ''
}

function limitingText(plan: Plan): string {
  if (!plan.result) return ''
  return plan.result.limiting.map((i) => rowText(i)).join('、')
}

function productYieldText(plan: Plan, rowIndex: number): string {
  const line = plan.result?.products.find((l) => l.index === rowIndex)
  if (!line) return '—'
  return `${approx(line.producedMol)}${formatFraction(line.producedMol)}`
}

function onGlobalKey(e: KeyboardEvent) {
  if (e.altKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault()
    doBalance()
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKey))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <main class="app">
    <header class="app-header">
      <h1>化学方程式配平与守恒核对工作台</h1>
      <p class="hint">
        本地精确整数/有理数求解 · 支持多层括号、结晶水、电荷与电子 e^- · 数据不离开浏览器
      </p>
    </header>

    <section class="examples" aria-label="示例">
      <span class="examples-label">载入示例：</span>
      <button
        v-for="ex in EXAMPLES"
        :key="ex.name"
        type="button"
        class="example-btn"
        @click="loadExample(ex)"
      >
        {{ ex.name }}
      </button>
    </section>

    <section class="columns">
      <div class="column" data-side="left">
        <h2>反应物</h2>
        <div
          v-for="(p, index) in leftParsed"
          :key="p.row.id"
          class="row"
          :class="{ invalid: p.row.text.trim() !== '' && !p.result.ok, dimmed: highlightedElement !== null && contribution(p.row.text, highlightedElement) === null }"
        >
          <input
            v-model="p.row.text"
            class="formula-input"
            :aria-label="`反应物 ${index + 1}`"
            :aria-invalid="!p.result.ok"
            placeholder="如 H2、Ca(OH)2、SO4^2-"
            @input="onInput"
            @keydown="onRowKeydown($event, 'left', p.row.id, index)"
          />
          <span v-if="snapshot && snapshot.result.kind === 'unique' && !stale" class="coef">
            {{ coefFor('left', index) }}
          </span>
          <div class="row-tools">
            <button type="button" :disabled="index === 0" @click="moveRow('left', p.row.id, -1)">↑</button>
            <button
              type="button"
              :disabled="index === leftRows.length - 1"
              @click="moveRow('left', p.row.id, 1)"
            >
              ↓
            </button>
            <button type="button" @click="removeRow('left', p.row.id)">删除</button>
          </div>
          <p v-if="p.row.text.trim() !== '' && !p.result.ok" class="error" role="alert">
            位置 {{ p.result.error.pos + 1 }}：{{ p.result.error.message }}
          </p>
        </div>
        <button type="button" class="add-btn" @click="addRow('left')">+ 添加反应物</button>
      </div>

      <div class="equals" aria-hidden="true">→</div>

      <div class="column" data-side="right">
        <h2>生成物</h2>
        <div
          v-for="(p, index) in rightParsed"
          :key="p.row.id"
          class="row"
          :class="{ invalid: p.row.text.trim() !== '' && !p.result.ok, dimmed: highlightedElement !== null && contribution(p.row.text, highlightedElement) === null }"
        >
          <input
            v-model="p.row.text"
            class="formula-input"
            :aria-label="`生成物 ${index + 1}`"
            :aria-invalid="!p.result.ok"
            placeholder="如 H2O、CuSO4·5H2O、e^-"
            @input="onInput"
            @keydown="onRowKeydown($event, 'right', p.row.id, index)"
          />
          <span v-if="snapshot && snapshot.result.kind === 'unique' && !stale" class="coef">
            {{ coefFor('right', index) }}
          </span>
          <div class="row-tools">
            <button type="button" :disabled="index === 0" @click="moveRow('right', p.row.id, -1)">↑</button>
            <button
              type="button"
              :disabled="index === rightRows.length - 1"
              @click="moveRow('right', p.row.id, 1)"
            >
              ↓
            </button>
            <button type="button" @click="removeRow('right', p.row.id)">删除</button>
          </div>
          <p v-if="p.row.text.trim() !== '' && !p.result.ok" class="error" role="alert">
            位置 {{ p.result.error.pos + 1 }}：{{ p.result.error.message }}
          </p>
        </div>
        <button type="button" class="add-btn" @click="addRow('right')">+ 添加生成物</button>
      </div>
    </section>

    <section class="actions">
      <button type="button" class="balance-btn" :disabled="!canBalance" @click="doBalance">
        配平（Alt+B）
      </button>
      <button
        type="button"
        :disabled="!equationText || stale"
        @click="copyEquation"
      >
        复制纯文本方程式
      </button>
      <span v-if="copyState === 'ok'" class="copy-ok">已复制</span>
      <span v-if="copyState === 'fail'" class="error">复制失败，请手动选择文本</span>
      <p v-if="!canBalance" class="hint">需要两侧都有非空物质，且全部解析通过后才能配平。</p>
    </section>

    <section v-if="globalMessage" class="banner info" role="status">{{ globalMessage }}</section>

    <section v-if="stale && snapshot" class="banner warn" role="status">
      输入已修改或存在解析错误，以下结果已失效，不再代表当前输入。请重新点击「配平」。
    </section>

    <section v-if="snapshot && !stale" class="results">
      <template v-if="snapshot.result.kind === 'unique'">
        <h2>配平结果</h2>
        <pre class="equation">{{ equationText }}</pre>

        <h2>守恒核对表</h2>
        <p class="hint">点击元素名称可突出该元素在各物质中的贡献；再次点击取消。</p>
        <table class="check-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>反应物总计（系数 × 原子数）</th>
              <th>生成物总计</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in checkTable"
              :key="row.label"
              :class="{ highlighted: highlightedElement === row.label }"
            >
              <td>
                <button
                  v-if="row.label !== '电荷'"
                  type="button"
                  class="el-btn"
                  @click="highlightedElement = highlightedElement === row.label ? null : row.label"
                >
                  {{ row.label }}
                </button>
                <span v-else>电荷</span>
              </td>
              <td>{{ row.label === '电荷' ? formatCharge(row.left) : row.left }}</td>
              <td>{{ row.label === '电荷' ? formatCharge(row.right) : row.right }}</td>
              <td :class="row.balanced ? 'ok' : 'error'">
                {{ row.balanced ? '守恒 ✓' : '不守恒 ✗' }}
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="highlightedElement" class="contrib-panel">
          <h3>「{{ highlightedElement }}」在各物质中的单份含量</h3>
          <ul>
            <li
              v-for="(r, i) in snapshot.rows"
              :key="i"
              :class="{ zero: contribution(r.text, highlightedElement) === null || contribution(r.text, highlightedElement) === 0n }"
            >
              <span class="side-tag">{{ r.side === 'left' ? '反应物' : '生成物' }}</span>
              {{ r.text }}：{{ contribution(r.text, highlightedElement) ?? 0 }} 个
              （计入总数时再乘系数 {{ snapshot.result.kind === 'unique' ? snapshot.result.coefficients[i] : '' }}）
            </li>
          </ul>
        </div>
      </template>

      <div v-else-if="snapshot.result.kind === 'no-solution'" class="banner bad" role="alert">
        <strong>无解：</strong>{{ snapshot.result.reason }}
      </div>
      <div v-else-if="snapshot.result.kind === 'has-nonpositive'" class="banner bad" role="alert">
        <strong>不能配平为全正系数：</strong>{{ snapshot.result.reason }}
        <p>唯一解（取绝对值，仅作核对）：{{ snapshot.result.sample.join('、') }}</p>
      </div>
      <div v-else-if="snapshot.result.kind === 'infinite'" class="banner bad" role="alert">
        <strong>解不唯一：</strong>{{ snapshot.result.reason }}
      </div>
    </section>

    <section v-if="dosingApplicable && snapshot" class="dosing" aria-label="限量试剂与投料方案">
      <h2>限量试剂与投料方案比较</h2>
      <p class="hint">
        假设：反应完全进行、无副反应，反应进度 ξ 由限量试剂决定。显示数值四舍五入保留 6
        位小数（「≈」表示近似），内部始终以精确有理数计算与比较。
      </p>

      <div v-if="hasElectron" class="banner warn" role="status">
        当前方程式含电子 e^-（半反应），投料与产量计算不适用，请改用完整反应。
      </div>

      <template v-else>
        <div class="plan-tabs" role="tablist" aria-label="投料方案列表">
          <button
            v-for="p in plans"
            :key="p.id"
            type="button"
            role="tab"
            :aria-selected="p.id === activePlanId"
            class="plan-tab"
            :class="{ active: p.id === activePlanId }"
            @click="activePlanId = p.id"
          >
            {{ p.name }}<span v-if="planResultValid(p)" class="plan-ok"> ✓</span>
          </button>
          <button type="button" class="plan-add" @click="addPlan">+ 新建方案</button>
        </div>

        <div class="plan-toolbar">
          <label class="plan-name">
            方案名
            <input v-model="activePlan.name" aria-label="方案名称" />
          </label>
          <button type="button" @click="duplicatePlan(activePlan)">复制方案</button>
          <button type="button" @click="removePlan(activePlan)">删除方案</button>
          <span class="toolbar-sep"></span>
          <button type="button" class="example-btn" @click="fillDosingExample('excess')">
            示例：试剂过量
          </button>
          <button type="button" class="example-btn" @click="fillDosingExample('stoich')">
            示例：恰好配比
          </button>
        </div>

        <p v-if="activePlan.result && !planResultValid(activePlan)" class="banner warn" role="status">
          方程式或投料已修改，「{{ activePlan.name }}」的旧结果已失效，请重新计算。
        </p>

        <table class="dosing-table">
          <thead>
            <tr>
              <th>物质</th>
              <th>系数</th>
              <th>投料数量</th>
              <th>单位</th>
              <th>摩尔质量 (g/mol)</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, i) in snapshot.rows"
              :key="r.id"
              :class="{ invalid: errorFor(i, 'amount') || errorFor(i, 'molarMass') }"
            >
              <td>
                <span class="side-tag">{{ r.side === 'left' ? '反应物' : '生成物' }}</span>
                {{ r.text }}
              </td>
              <td class="coef-cell">{{ coefOf(i) }}</td>
              <template v-if="r.side === 'left'">
                <td>
                  <input
                    v-model="inputFor(activePlan, r.id).amountText"
                    class="num-input"
                    :aria-label="`${r.text} 投料数量`"
                    :aria-invalid="!!errorFor(i, 'amount')"
                    placeholder="如 2、0.5"
                    @input="onDosingEdit(activePlan)"
                    @keydown="onDosingKeydown"
                  />
                  <p v-if="errorFor(i, 'amount')" class="error" role="alert">
                    {{ errorFor(i, 'amount') }}
                  </p>
                </td>
                <td>
                  <select
                    v-model="inputFor(activePlan, r.id).unit"
                    :aria-label="`${r.text} 投料单位`"
                    @change="onDosingEdit(activePlan)"
                  >
                    <option value="mol">mol</option>
                    <option value="mmol">mmol</option>
                    <option value="g">g</option>
                  </select>
                </td>
              </template>
              <td v-else colspan="2" class="hint">生成物无需投料</td>
              <td>
                <input
                  v-model="inputFor(activePlan, r.id).molarMassText"
                  class="num-input"
                  :aria-label="`${r.text} 摩尔质量`"
                  :aria-invalid="!!errorFor(i, 'molarMass')"
                  placeholder="选填"
                  @input="onDosingEdit(activePlan)"
                  @keydown="onDosingKeydown"
                />
                <p v-if="errorFor(i, 'molarMass')" class="error" role="alert">
                  {{ errorFor(i, 'molarMass') }}
                </p>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="actions">
          <button
            type="button"
            class="balance-btn"
            :disabled="activePlanErrors.length > 0"
            @click="computePlan(activePlan)"
          >
            计算「{{ activePlan.name }}」投料结果
          </button>
          <span v-if="activePlanErrors.length > 0" class="hint">
            请先修正上方标红的 {{ activePlanErrors.length }} 处输入。
          </span>
        </div>

        <div v-if="planResultValid(activePlan) && activePlan.result" class="dosing-result">
          <h3>「{{ activePlan.name }}」计算结果</h3>
          <p>
            反应进度 ξ = {{ approx(activePlan.result.extent)
            }}{{ formatFraction(activePlan.result.extent) }} mol ；
            限量试剂：
            <strong>{{ limitingText(activePlan) }}</strong>
            <span v-if="activePlan.result.limiting.length > 1">（并列限量，恰好配比）</span>
          </p>

          <h4>反应物：换算、比例与剩余</h4>
          <table class="check-table">
            <thead>
              <tr>
                <th>物质</th>
                <th>投料</th>
                <th>换算 n (mol)</th>
                <th>n ÷ 系数</th>
                <th>消耗 (mol)</th>
                <th>剩余 (mol)</th>
                <th>剩余 (g)</th>
                <th>角色</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in activePlan.result.reactants" :key="line.index">
                <td>{{ rowText(line.index) }}</td>
                <td>
                  {{ inputFor(activePlan, snapshot.rows[line.index].id).amountText }}
                  {{ inputFor(activePlan, snapshot.rows[line.index].id).unit }}
                </td>
                <td>{{ approx(line.initialMol) }}{{ formatFraction(line.initialMol) }}</td>
                <td>{{ approx(line.ratio) }}{{ formatFraction(line.ratio) }}</td>
                <td>{{ approx(line.consumedMol) }}{{ formatFraction(line.consumedMol) }}</td>
                <td>{{ approx(line.remainingMol) }}{{ formatFraction(line.remainingMol) }}</td>
                <td>
                  <span v-if="line.remainingG">
                    {{ approx(line.remainingG) }}{{ formatFraction(line.remainingG) }}
                  </span>
                  <span v-else class="hint">—</span>
                </td>
                <td :class="line.limiting ? 'limiting' : 'ok'">
                  {{ line.limiting ? '限量试剂' : '过量' }}
                </td>
              </tr>
            </tbody>
          </table>

          <h4>生成物：理论产量</h4>
          <table class="check-table">
            <thead>
              <tr>
                <th>物质</th>
                <th>理论产量 (mol)</th>
                <th>理论产量 (g)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="line in activePlan.result.products" :key="line.index">
                <td>{{ rowText(line.index) }}</td>
                <td>{{ approx(line.producedMol) }}{{ formatFraction(line.producedMol) }}</td>
                <td>
                  <span v-if="line.producedG">
                    {{ approx(line.producedG) }}{{ formatFraction(line.producedG) }}
                  </span>
                  <span v-else class="hint">未填摩尔质量</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="comparablePlans.length > 0" class="compare">
          <h3>方案对比（{{ comparablePlans.length }} 个有效方案）</h3>
          <table class="check-table compare-table">
            <thead>
              <tr>
                <th>项目</th>
                <th v-for="p in comparablePlans" :key="p.id">{{ p.name }}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>限量试剂</td>
                <td v-for="p in comparablePlans" :key="p.id">{{ limitingText(p) }}</td>
              </tr>
              <tr>
                <td>反应进度 ξ (mol)</td>
                <td v-for="p in comparablePlans" :key="p.id">
                  {{ approx(p.result!.extent) }}{{ formatFraction(p.result!.extent) }}
                </td>
              </tr>
              <template v-for="(r, i) in snapshot.rows" :key="r.id">
                <tr v-if="r.side === 'right'">
                  <td>{{ r.text }} 产量 (mol)</td>
                  <td v-for="p in comparablePlans" :key="p.id">{{ productYieldText(p, i) }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <section class="syntax-help">
      <h2>输入语法</h2>
      <ul>
        <li>元素符号首字母大写、次字母小写，如 <code>Fe</code>、<code>Cl</code>；下标写正整数，如 <code>H2O</code>。</li>
        <li>支持多层圆括号（也可用中括号、花括号）：<code>Ca3(Fe(CN)6)2</code>，括号外下标乘整个分组。</li>
        <li>结晶水用 <code>·</code> 或 <code>.</code> 分隔：<code>CuSO4·5H2O</code>，整数只乘点号后的该一段。</li>
        <li>电荷写在末尾：<code>Mg^2+</code>、<code>SO4^2-</code>、<code>H^+</code>；电子固定写 <code>e^-</code>。</li>
        <li>每行一种物质；在输入框内按 Enter 跳到下一行（末行自动新增）；空行按 Backspace 删除该行。</li>
      </ul>
    </section>
  </main>
</template>

<style>
:root {
  --bg: #f5f7fa;
  --panel: #ffffff;
  --border: #d7dde6;
  --accent: #2563eb;
  --accent-soft: #dbeafe;
  --danger: #dc2626;
  --danger-soft: #fee2e2;
  --warn: #b45309;
  --warn-soft: #fef3c7;
  --ok: #15803d;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: #1f2937;
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.app {
  max-width: 1080px;
  margin: 0 auto;
  padding: 24px 20px 60px;
}

.app-header h1 {
  margin: 0 0 4px;
  font-size: 26px;
}

.hint {
  color: #6b7280;
  font-size: 14px;
}

.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 16px 0;
  padding: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.examples-label {
  font-weight: 600;
}

button {
  font: inherit;
  cursor: pointer;
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px;
  padding: 4px 10px;
}

button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.example-btn {
  background: var(--accent-soft);
  border-color: transparent;
  color: #1e40af;
}

.columns {
  display: grid;
  grid-template-columns: 1fr 48px 1fr;
  gap: 12px;
  align-items: start;
}

.column {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
}

.column h2 {
  margin: 0 0 10px;
  font-size: 18px;
}

.equals {
  align-self: center;
  text-align: center;
  font-size: 28px;
  color: var(--accent);
  font-weight: 700;
}

.row {
  position: relative;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  margin-bottom: 8px;
  transition: opacity 0.15s, background 0.15s;
}

.row.invalid {
  background: var(--danger-soft);
  border-color: #fca5a5;
}

.row.dimmed {
  opacity: 0.35;
}

.formula-input {
  width: 100%;
  font-size: 17px;
  font-family: 'Cambria Math', 'Times New Roman', monospace;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.formula-input:focus {
  outline: 2px solid var(--accent-soft);
  border-color: var(--accent);
}

.coef {
  position: absolute;
  left: -14px;
  top: 10px;
  font-weight: 700;
  color: var(--accent);
  font-size: 16px;
}

.row-tools {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.row-tools button {
  padding: 2px 8px;
  font-size: 13px;
}

.add-btn {
  width: 100%;
  padding: 8px;
  border-style: dashed;
  color: var(--accent);
}

.error {
  color: var(--danger);
  font-size: 13px;
  margin: 4px 0 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0;
  flex-wrap: wrap;
}

.balance-btn {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 10px 22px;
  font-size: 16px;
  border-radius: 8px;
}

.balance-btn:hover:not(:disabled) {
  background: #1d4ed8;
  color: #fff;
}

.copy-ok {
  color: var(--ok);
  font-size: 14px;
}

.banner {
  border-radius: 8px;
  padding: 12px 14px;
  margin: 12px 0;
  font-size: 15px;
}

.banner.warn {
  background: var(--warn-soft);
  color: var(--warn);
  border: 1px solid #fcd34d;
}

.banner.bad {
  background: var(--danger-soft);
  color: #991b1b;
  border: 1px solid #fca5a5;
}

.banner.info {
  background: var(--accent-soft);
  color: #1e40af;
  border: 1px solid #93c5fd;
}

.results {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
  margin: 16px 0;
}

.equation {
  font-size: 20px;
  font-family: 'Cambria Math', 'Times New Roman', serif;
  background: var(--accent-soft);
  border-radius: 8px;
  padding: 12px 16px;
  overflow-x: auto;
}

.check-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 8px;
}

.check-table th,
.check-table td {
  border: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
}

.check-table th {
  background: #f1f5f9;
}

.check-table tr.highlighted {
  background: #fef9c3;
}

.check-table .ok {
  color: var(--ok);
}

.el-btn {
  border: none;
  background: none;
  color: var(--accent);
  font-weight: 700;
  padding: 0;
  text-decoration: underline dotted;
}

.contrib-panel {
  margin-top: 16px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.contrib-panel ul {
  margin: 6px 0;
  padding-left: 18px;
}

.contrib-panel li.zero {
  opacity: 0.4;
}

.side-tag {
  display: inline-block;
  font-size: 12px;
  background: #e5e7eb;
  border-radius: 4px;
  padding: 0 6px;
  margin-right: 6px;
}

.syntax-help {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 18px;
}

.dosing {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px 18px;
  margin: 16px 0;
}

.dosing h2 {
  margin-top: 0;
}

.plan-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 10px;
}

.plan-tab {
  border-radius: 6px 6px 0 0;
  border-bottom: none;
  padding: 6px 14px;
  background: #f1f5f9;
}

.plan-tab.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}

.plan-tab.active:hover:not(:disabled) {
  color: #fff;
}

.plan-ok {
  color: #4ade80;
}

.plan-add {
  border-style: dashed;
  color: var(--accent);
}

.plan-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.plan-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}

.plan-name input {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  width: 140px;
}

.toolbar-sep {
  width: 1px;
  height: 22px;
  background: var(--border);
}

.dosing-table {
  width: 100%;
  border-collapse: collapse;
}

.dosing-table th,
.dosing-table td {
  border: 1px solid var(--border);
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

.dosing-table th {
  background: #f1f5f9;
}

.dosing-table tr.invalid {
  background: var(--danger-soft);
}

.coef-cell {
  font-weight: 700;
  color: var(--accent);
}

.num-input {
  width: 110px;
  font: inherit;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.num-input[aria-invalid='true'] {
  border-color: var(--danger);
}

.dosing-table select {
  font: inherit;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.dosing-result h3,
.compare h3 {
  margin-bottom: 6px;
}

.dosing-result h4 {
  margin: 14px 0 6px;
}

.check-table td.limiting {
  color: var(--warn);
  font-weight: 700;
}

.compare {
  margin-top: 18px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}

.syntax-help h2 {
  margin-top: 0;
  font-size: 17px;
}

.syntax-help ul {
  margin: 0;
  padding-left: 20px;
  line-height: 1.8;
}

code {
  background: #f1f5f9;
  border-radius: 4px;
  padding: 1px 5px;
  font-family: 'Cambria Math', monospace;
}

@media (max-width: 760px) {
  .columns {
    grid-template-columns: 1fr;
  }
  .equals {
    transform: rotate(90deg);
  }
}
</style>

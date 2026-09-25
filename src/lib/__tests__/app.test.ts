import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../../App.vue'

describe('App 工作台', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('载入默认输入并配平，展示系数与守恒表', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    const eq = wrapper.find('.equation').text()
    expect(eq.replace(/\s+/g, '')).toContain('2H2+O2→2H2O')
    const rows = wrapper.findAll('.check-table tbody tr')
    const texts = rows.map((r) => r.text())
    expect(texts.some((t) => t.includes('H') && t.includes('守恒'))).toBe(true)
    expect(texts.some((t) => t.includes('电荷') && t.includes('守恒'))).toBe(true)
  })

  it('修改输入后旧结果标记失效', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.equation').exists()).toBe(true)
    const input = wrapper.find('[data-side="left"] .formula-input')
    await input.setValue('H3')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.banner.warn').exists()).toBe(true)
    expect(wrapper.find('.results').exists()).toBe(false)
  })

  it('解析失败时定位到对应物质并禁用配平', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    const input = wrapper.find('[data-side="left"] .formula-input')
    await input.setValue('H(0)')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.row.invalid').exists()).toBe(true)
    expect(wrapper.find('.balance-btn').attributes('disabled')).toBeDefined()
  })

  it('不能全正配平时给出明确原因而非伪造系数', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    const leftInputs = wrapper.findAll('[data-side="left"] .formula-input')
    await leftInputs[0].setValue('H2')
    await leftInputs[1].setValue('H2O')
    const rightInputs = wrapper.findAll('[data-side="right"] .formula-input')
    await rightInputs[0].setValue('O2')
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.banner.bad').text()).toMatch(/无解|零或负系数/)
  })
})

describe('投料方案', () => {
  async function balancedApp() {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('新建方案并计算：氧气过量时氢气限量，展示剩余与产量', async () => {
    const wrapper = await balancedApp()
    await wrapper.find('.plan-bar .example-btn').trigger('click') // + 新建方案
    await wrapper.vm.$nextTick()
    const amounts = wrapper.findAll('.stoich-section .amount-input')
    // 顺序：H2 数量、H2 摩尔质量、O2 数量、O2 摩尔质量、H2O 摩尔质量
    await amounts[0].setValue('2')
    await amounts[2].setValue('3')
    const calc = wrapper.findAll('.stoich-section .balance-btn')[0]
    await calc.trigger('click')
    await wrapper.vm.$nextTick()
    const text = wrapper.find('.plan-result').text()
    expect(text).toContain('限量试剂')
    expect(text).toContain('H2')
    expect(text).toContain('完全进行且无副反应')
  })

  it('空数量不会被当作 0，定位提示错误', async () => {
    const wrapper = await balancedApp()
    await wrapper.find('.plan-bar .example-btn').trigger('click')
    await wrapper.vm.$nextTick()
    const amounts = wrapper.findAll('.stoich-section .amount-input')
    await amounts[0].setValue('1')
    // O2 留空
    await wrapper.findAll('.stoich-section .balance-btn')[0].trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.plan-result .banner.bad').exists()).toBe(true)
    expect(wrapper.find('.amount-input.invalid').exists()).toBe(true)
    expect(wrapper.find('.plan-result').text()).not.toContain('限量试剂：')
  })

  it('复制方案后独立编辑互不影响，编辑使结果失效', async () => {
    const wrapper = await balancedApp()
    await wrapper.find('.plan-bar .example-btn').trigger('click')
    await wrapper.vm.$nextTick()
    const amounts = wrapper.findAll('.stoich-section .amount-input')
    await amounts[0].setValue('2')
    await amounts[2].setValue('1')
    await wrapper.findAll('.stoich-section .balance-btn')[0].trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.plan-result').exists()).toBe(true)

    // 编辑使结果失效
    await amounts[0].setValue('4')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.plan-result').exists()).toBe(false)
    expect(wrapper.find('.plan-body .banner.warn').exists()).toBe(true)

    // 复制方案，副本独立
    await wrapper.findAll('.plan-tools button')[0].trigger('click')
    await wrapper.vm.$nextTick()
    const tabs = wrapper.findAll('.plan-tab')
    expect(tabs.length).toBe(2)
    const amounts2 = wrapper.findAll('.stoich-section .amount-input')
    expect((amounts2[0].element as HTMLInputElement).value).toBe('4')
    await amounts2[0].setValue('9')
    // 切回原方案，值不受副本影响
    await wrapper.findAll('.plan-tab')[0].trigger('click')
    await wrapper.vm.$nextTick()
    const amountsBack = wrapper.findAll('.stoich-section .amount-input')
    expect((amountsBack[0].element as HTMLInputElement).value).toBe('4')
  })

  it('恰好配比示例生成并列限量并进入方案对比', async () => {
    const wrapper = await balancedApp()
    const exampleBtns = wrapper.findAll('.plan-bar .example-btn')
    await exampleBtns[1].trigger('click') // 示例：恰好配比
    await wrapper.vm.$nextTick()
    await wrapper.findAll('.stoich-section .balance-btn')[0].trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.limiting-line').text()).toContain('H2、O2')
    expect(wrapper.find('.compare-block').exists()).toBe(true)
  })

  it('修改化学式后方案结果失效', async () => {
    const wrapper = await balancedApp()
    const exampleBtns = wrapper.findAll('.plan-bar .example-btn')
    await exampleBtns[1].trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.findAll('.stoich-section .balance-btn')[0].trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.plan-result').exists()).toBe(true)
    const input = wrapper.find('[data-side="left"] .formula-input')
    await input.setValue('H2S')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.plan-result').exists()).toBe(false)
    expect(wrapper.find('.stoich-section .banner.warn').text()).toContain('已失效')
  })

  it('含电子的反应提示投料不适用', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    const exBtns = wrapper.findAll('.examples .example-btn')
    await exBtns[3].trigger('click') // 离子-电子反应
    await wrapper.vm.$nextTick()
    await wrapper.find('.balance-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.stoich-section .banner.info').text()).toContain('不适用')
  })
})

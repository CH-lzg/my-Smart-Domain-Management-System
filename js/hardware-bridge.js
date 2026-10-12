;(function (window, document) {
  'use strict'

  const STORAGE_KEY = 'zhiyuHardwareState'
  const DEVICE_KEY = 'zhiyuDeviceStates'
  const HISTORY_KEY = 'zhiyuHardwareHistory'
  const CONFIG_KEY = 'zhiyuHardwareConfig'
  const CHANNEL_NAME = 'zhiyu-hardware-channel'

  const defaultState = {
    timestamp: null,
    connection: { mode: 'demo', status: '运行中', lastError: '' },
    environment: {
      temperature: 24.6,
      humidity: 45,
      light: 65,
      presence: false,
    },
    host: { name: '本地控制器', cpu: 0, memory: 0, uptime: '--' },
    devices: {
      light: { name: '灯光', state: 'on', value: 72, online: true },
      airConditioner: { name: '空调', state: 'on', value: 24, online: true },
      projector: { name: '投影', state: 'off', value: 0, online: true },
      monitor: { name: '监控', state: 'on', value: 0, online: true },
    },
    sensors: {
      temperature: { name: '温湿度传感器', status: '正常', online: true },
      light: { name: '光照传感器', status: '正常', online: true },
      presence: { name: '人体检测器', status: '正常', online: true },
    },
    settings: {
      sampleInterval: 10,
      autoMode: true,
      network: '本地',
      logStorage: '本地',
    },
    alert: '',
  }

  let state = mergeState(readJson(STORAGE_KEY, {}))
  let socket = null
  let pollTimer = null
  let channel = null
  try {
    channel = new BroadcastChannel(CHANNEL_NAME)
  } catch (e) {
    channel = null
  }

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback))
    } catch (e) {
      return fallback
    }
  }
  function copy(value) {
    return JSON.parse(JSON.stringify(value))
  }
  function mergeState(next) {
    const incoming = next || {}
    return Object.assign(copy(defaultState), incoming, {
      connection: Object.assign(
        {},
        defaultState.connection,
        incoming.connection || {},
      ),
      environment: Object.assign(
        {},
        defaultState.environment,
        incoming.environment || {},
      ),
      host: Object.assign({}, defaultState.host, incoming.host || {}),
      devices: Object.assign({}, defaultState.devices, incoming.devices || {}),
      sensors: Object.assign({}, defaultState.sensors, incoming.sensors || {}),
      settings: Object.assign(
        {},
        defaultState.settings,
        incoming.settings || {},
      ),
    })
  }
  function readHistory() {
    const history = readJson(HISTORY_KEY, {})
    return {
      samples: Array.isArray(history.samples) ? history.samples : [],
      events: Array.isArray(history.events) ? history.events : [],
    }
  }
  function writeHistory(history) {
    history.samples = history.samples.slice(-120)
    history.events = history.events.slice(-40)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  }
  function recordSample(current) {
    const history = readHistory()
    history.samples.push({
      timestamp: current.timestamp,
      temperature: current.environment.temperature,
      humidity: current.environment.humidity,
      light: current.environment.light,
    })
    writeHistory(history)
  }
  function recordDeviceEvent(id, previous, next, source) {
    if (!previous || previous.state === next.state) return
    const history = readHistory()
    history.events.push({
      timestamp: new Date().toISOString(),
      deviceId: id,
      device: next.name,
      operation: next.state === 'on' ? '打开' : '关闭',
      decision: source || '手动',
      reason:
        source === 'AI' ? '虚拟环境策略触发设备状态调整' : '用户操作设备开关',
    })
    writeHistory(history)
  }
  function emit(next, broadcast) {
    const previous = state
    state = mergeState(next)
    state.timestamp = new Date().toISOString()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    recordSample(state)
    if (broadcast && channel) channel.postMessage(state)
    window.dispatchEvent(
      new CustomEvent('zhiyu:hardware-state', { detail: copy(state) }),
    )
    renderBindings(state)
  }
  function update(patch) {
    emit(mergeState(Object.assign({}, state, patch || {})), true)
    return copy(state)
  }

  function setDevice(id, patch, source) {
    if (!state.devices[id]) throw new Error('未知设备: ' + id)
    const previous = state.devices[id]
    const devices = Object.assign({}, state.devices, {
      [id]: Object.assign({}, previous, patch || {}),
    })
    const legacy = readJson(DEVICE_KEY, {})
    legacy[id] = devices[id].state === 'on'
    localStorage.setItem(DEVICE_KEY, JSON.stringify(legacy))
    recordDeviceEvent(id, previous, devices[id], source)
    update({ devices: devices })
    return devices[id]
  }
  async function command(id, action, value) {
    const config = readJson(CONFIG_KEY, {})
    const url = config.commandUrl
    const payload = {
      deviceId: id,
      action: action,
      value: value,
      timestamp: new Date().toISOString(),
    }
    if (!url) {
      const stateValue =
        action === 'off'
          ? 'off'
          : action === 'on'
            ? 'on'
            : state.devices[id].state
      return setDevice(id, {
        state: stateValue,
        value: value === undefined ? state.devices[id].value : value,
      })
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('设备控制失败: ' + response.status)
    const result = await response.json()
    update(result.state || result)
    return result
  }
  async function fetchState(url) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error('硬件状态请求失败: ' + response.status)
    const result = await response.json()
    update(
      Object.assign({}, result, {
        connection: { mode: 'http', status: '已连接', lastError: '' },
      }),
    )
    return copy(state)
  }
  function connect(url) {
    if (socket) socket.close()
    socket = new WebSocket(url)
    socket.addEventListener('open', function () {
      update({
        connection: { mode: 'websocket', status: '已连接', lastError: '' },
      })
    })
    socket.addEventListener('message', function (event) {
      try {
        update(JSON.parse(event.data))
      } catch (e) {
        update({ connection: { status: '数据格式错误', lastError: e.message } })
      }
    })
    socket.addEventListener('error', function () {
      update({
        connection: { status: '连接异常', lastError: 'WebSocket error' },
      })
    })
    socket.addEventListener('close', function () {
      update({ connection: { status: '已断开' } })
    })
    return socket
  }
  function startPolling(url, interval) {
    stopPolling()
    fetchState(url).catch(function (error) {
      update({
        connection: {
          mode: 'http',
          status: '请求失败',
          lastError: error.message,
        },
      })
    })
    pollTimer = window.setInterval(
      function () {
        fetchState(url).catch(function (error) {
          update({
            connection: { status: '请求失败', lastError: error.message },
          })
        })
      },
      Math.max(1000, interval || 10000),
    )
  }
  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer)
    pollTimer = null
  }
  function configure(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config || {}))
    return readJson(CONFIG_KEY, {})
  }

  // 无接口时生成模拟传感器数据。
  function seedVirtualHistory() {
    const history = readHistory()
    if (history.samples.length >= 18) return
    const base = Date.now()
    history.samples = []
    for (let index = 23; index >= 0; index -= 1) {
      const time = base - index * 5 * 60 * 1000
      history.samples.push({
        timestamp: new Date(time).toISOString(),
        temperature: Number((24.6 + Math.sin(index / 3.2) * 1.2).toFixed(1)),
        humidity: Math.round(45 + Math.cos(index / 3.8) * 5),
        light: Math.max(
          8,
          Math.min(96, Math.round(62 + Math.sin(index / 2.1) * 24)),
        ),
      })
    }
    if (!history.events.length) {
      const deviceIds = Object.keys(state.devices)
      for (let index = 0; index < 6; index += 1) {
        const deviceId = deviceIds[index % deviceIds.length]
        const device = state.devices[deviceId]
        history.events.push({
          timestamp: new Date(
            base - (index + 1) * 17 * 60 * 1000,
          ).toISOString(),
          deviceId: deviceId,
          device: device.name,
          operation: index % 3 === 0 ? '关闭' : '打开',
          decision: index % 2 ? 'AI' : '手动',
          reason:
            index % 2 ? '虚拟环境策略触发设备状态调整' : '用户操作设备开关',
        })
      }
    }
    writeHistory(history)
  }
  function createVirtualSample() {
    const now = Date.now() / 60000
    const environment = {
      temperature: Number((24.6 + Math.sin(now / 2.4) * 1.2).toFixed(1)),
      humidity: Math.round(45 + Math.sin(now / 3.1) * 5),
      light: Math.max(
        8,
        Math.min(96, Math.round(62 + Math.sin(now / 1.8) * 24)),
      ),
      presence: Math.sin(now / 4.2) > 0.18,
    }
    const sensors = Object.assign({}, state.sensors)
    Object.keys(sensors).forEach(function (key) {
      sensors[key] = Object.assign({}, sensors[key], {
        status: '正常',
        online: true,
      })
    })
    return {
      environment: environment,
      sensors: sensors,
      connection: { mode: 'demo', status: '运行中', lastError: '' },
    }
  }
  function startVirtualData(interval) {
    stopPolling()
    update(createVirtualSample())
    pollTimer = window.setInterval(
      function () {
        update(createVirtualSample())
      },
      Math.max(1000, interval || 5000),
    )
  }

  function text(value, fallback) {
    return value === undefined || value === null
      ? fallback || '--'
      : String(value)
  }
  function renderBindings(current) {
    document
      .querySelectorAll('[data-hardware="temperature"]')
      .forEach(function (el) {
        el.innerHTML =
          text(current.environment.temperature) + '<small> °C</small>'
      })
    document
      .querySelectorAll('[data-hardware="humidity"]')
      .forEach(function (el) {
        el.innerHTML = text(current.environment.humidity) + '<small> %</small>'
      })
    document
      .querySelectorAll('[data-hardware="light-level"]')
      .forEach(function (el) {
        el.innerHTML = text(current.environment.light) + '<small> %</small>'
      })
    document
      .querySelectorAll('[data-hardware="presence"]')
      .forEach(function (el) {
        el.textContent = current.environment.presence ? '有人' : '无人'
      })
    document.querySelectorAll('[data-hardware-device]').forEach(function (el) {
      const device = current.devices[el.dataset.hardwareDevice]
      if (!device) return
      el.dataset.state = device.state
      el.classList.toggle('is-online', device.online !== false)
      el.classList.toggle('is-offline', device.online === false)
      const value = el.querySelector('[data-hardware-value]')
      if (value)
        value.textContent = device.state === 'on' ? '正在运行' : '未运行'
    })
    document
      .querySelectorAll('[data-hardware="connection"]')
      .forEach(function (el) {
        el.textContent = current.connection.status
      })
    document
      .querySelectorAll('[data-hardware="sensor-status"]')
      .forEach(function (el) {
        const sensor = current.sensors[el.dataset.sensorStatus]
        el.textContent = sensor ? sensor.status : '未知'
        el.classList.toggle('is-offline', !sensor || sensor.online === false)
      })
    document.querySelectorAll('[data-hardware="alert"]').forEach(function (el) {
      el.textContent = current.alert || '暂无告警'
    })
  }

  if (channel)
    channel.addEventListener('message', function (event) {
      state = mergeState(event.data)
      renderBindings(state)
      window.dispatchEvent(
        new CustomEvent('zhiyu:hardware-state', { detail: copy(state) }),
      )
    })
  window.addEventListener('storage', function (event) {
    if (event.key === STORAGE_KEY) {
      state = mergeState(readJson(STORAGE_KEY, {}))
      renderBindings(state)
    }
  })
  seedVirtualHistory()
  window.ZhiyuHardware = {
    getState: function () {
      return copy(state)
    },
    getHistory: function () {
      return copy(readHistory())
    },
    update: update,
    setDevice: setDevice,
    command: command,
    fetchState: fetchState,
    connect: connect,
    startPolling: startPolling,
    startVirtualData: startVirtualData,
    stopPolling: stopPolling,
    configure: configure,
  }
  window.dispatchEvent(
    new CustomEvent('zhiyu:hardware-ready', { detail: copy(state) }),
  )
  renderBindings(state)
  document.addEventListener('DOMContentLoaded', function () {
    renderBindings(state)
  })
  if (
    !readJson(CONFIG_KEY, {}).stateUrl &&
    !readJson(CONFIG_KEY, {}).websocketUrl
  )
    startVirtualData(state.settings.sampleInterval * 1000)
})(window, document)

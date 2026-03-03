import { MessageBot } from '@bhmb/bot'
import { join } from 'path'
import { readFile, writeFile, appendFile } from 'fs/promises'
import { config } from '../config'
import { sendPrivateMessage } from '../private-message'
import { normalizePlayerName } from './helpers/blockhead-mapping'
import { getBankAPI as _getBankAPI, getQuestAPI as _getQuestAPI } from './helpers/extension-api'
import { isAdmin as isAdminHelper } from './helpers/isAdmin'

type JobKey = string

interface JobDefinition {
  key: JobKey
  name: string
  dailyPay: number
}

interface JobApplication {
  time: string
  playerName: string
  jobKey: JobKey
  jobName: string
  discordName: string
  status: 'pending'
}

interface JobActionLog {
  time: string
  action: 'hire' | 'reject' | 'fire' | 'promote'
  actor: string
  playerName: string
  jobKey?: JobKey
  jobName?: string
  dailyPay?: number
  reason?: string
}

interface JobReportLog {
  time: string
  playerName: string
  jobKey: JobKey
  jobName: string
  message: string
}

interface JobFlagLog {
  time: string
  playerName: string
  jobKey: JobKey
  jobName: string
  reason: string
  lastReportAt: number | null
}

interface EmployeeRecord {
  playerName: string
  jobKey: JobKey
  jobName: string
  dailyPay: number
  hiredAt: number
  lastPaidAt: number | null
  lastReportAt: number | null
  lastFlagAt: number | null
}

MessageBot.registerExtension('job-system', (ex) => {
  console.log('Job System extension loaded!')

  const applicationsPath = join(config.paths.dataDir, 'job-applications.jsonl')
  const actionsPath = join(config.paths.dataDir, 'job-actions.jsonl')
  const reportsPath = join(config.paths.dataDir, 'job-reports.jsonl')
  const flagsPath = join(config.paths.dataDir, 'job-flags.jsonl')
  const employeesPath = join(config.paths.dataDir, 'job-employees.json')

  // Build JOBS record from config
  const JOBS: Record<JobKey, JobDefinition> = {}
  for (const job of config.jobs) {
    JOBS[job.key] = { key: job.key, name: job.name, dailyPay: job.dailyPay }
  }

  const employees = new Map<string, EmployeeRecord>()

  const normalizeJobInput = (input: string): JobKey | null => {
    const normalized = input
      .toUpperCase()
      .replace(/[\s-]+/g, '_')
      .replace(/[^A-Z_]/g, '')
    if (JOBS[normalized]) return normalized
    return null
  }

  const isEmployer = (playerName: string): boolean => {
    // Admins from the server's admin list can manage jobs
    return isAdminHelper(playerName)
  }

  const getBankAPI = () => _getBankAPI(ex.bot)
  const getQuestAPI = () => _getQuestAPI(ex.bot)

  const appendJsonLine = async (path: string, payload: object) => {
    await appendFile(path, `${JSON.stringify(payload)}\n`)
  }

  const saveEmployees = async () => {
    const data = Array.from(employees.values())
    await writeFile(employeesPath, JSON.stringify(data, null, 2))
  }

  const loadEmployees = async () => {
    try {
      const raw = await readFile(employeesPath, 'utf8')
      const parsed = JSON.parse(raw) as EmployeeRecord[]
      for (const record of parsed) {
        employees.set(normalizePlayerName(record.playerName, 'upper'), record)
      }
      console.log(`[Job System] Loaded ${employees.size} employees`)
    } catch {
      console.log('[Job System] No existing employees file, starting fresh')
    }
  }

  const flagMissingReports = async () => {
    const now = Date.now()
    const weekMs = 7 * 24 * 60 * 60 * 1000
    for (const record of employees.values()) {
      const lastReportAt = record.lastReportAt ?? record.hiredAt
      if ((now - lastReportAt) < weekMs) continue
      if (record.lastFlagAt && (now - record.lastFlagAt) < weekMs) continue
      record.lastFlagAt = now
      const logEntry: JobFlagLog = {
        time: new Date().toISOString(),
        playerName: record.playerName,
        jobKey: record.jobKey,
        jobName: record.jobName,
        reason: 'Missing weekly report',
        lastReportAt: record.lastReportAt
      }
      await appendJsonLine(flagsPath, logEntry)
      console.log(`[Job System] Flagged ${record.playerName} for missing weekly report`)
    }
    await saveEmployees()
  }

  const runDailyPay = async () => {
    const bankAPI = getBankAPI()
    if (!bankAPI) {
      console.warn('[Job System] virtual-bank not available, skipping daily pay')
      return
    }
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    for (const record of employees.values()) {
      const lastPaidAt = record.lastPaidAt ?? 0
      if (now - lastPaidAt < dayMs) continue
      record.lastPaidAt = now
      bankAPI.addCoins(record.playerName, record.dailyPay, `Daily pay: ${record.jobName}`)
      console.log(`[Job System] Paid ${record.dailyPay} tokens to ${record.playerName}`)
    }
    await saveEmployees()
  }

  ex.world.onMessage.sub(({ player, message }) => {
    const msg = message.trim()
    if (!msg.startsWith('/')) return
    const parts = msg.split(' ')
    const cmd = parts[0].toLowerCase()

    if (cmd === '/jobs') {

      sendPrivateMessage(player.name, 'Head to the Job outpost next to the greenhouse to learn more about jobs.\n Available jobs: Railroad Installer, Public Builder, Electrician. Must complete quest level 10 before applying')
      return
    }

    if (cmd === '/apply') {
      const jobInput = parts[1]
      const discordName = parts.slice(2).join(' ').trim()
      if (!jobInput || !discordName) {
        sendPrivateMessage(player.name, 'Usage: /apply <jobposition> <discordname>')
        return
      }

      const questAPI = getQuestAPI()
      const completed = questAPI && typeof questAPI.hasCompletedQuest === 'function'
        ? questAPI.hasCompletedQuest(player.name, '10')
        : true
      if (!completed) {
        sendPrivateMessage(player.name, `${player.name}: You must complete quest 10 before applying.`)
        return
      }

      const jobKey = normalizeJobInput(jobInput)
      if (!jobKey) {
        sendPrivateMessage(player.name, 'Unknown job. Use /jobs for the list.')
        return
      }

      const normalized = normalizePlayerName(player.name, 'upper')
      if (employees.has(normalized)) {
        const current = employees.get(normalized)!
        sendPrivateMessage(player.name, `You are already employed as ${current.jobName}.`)
        return
      }

      const application: JobApplication = {
        time: new Date().toISOString(),
        playerName: player.name,
        jobKey,
        jobName: JOBS[jobKey].name,
        discordName,
        status: 'pending'
      }

      appendJsonLine(applicationsPath, application)
        .catch(err => console.error('[Job System] Failed to log application:', err))

      console.log(`[Job System] Application: ${player.name} -> ${JOBS[jobKey].name} (${discordName})`)
      sendPrivateMessage(player.name, 'Thanks! Your application was received! You will get a response on Discord within 2 days.')
      return
    }

    if (cmd === '/rep') {
      const reportMessage = parts.slice(1).join(' ').trim()
      if (!reportMessage) {
        sendPrivateMessage(player.name, 'Usage: /rep <message>')
        return
      }
      const normalized = normalizePlayerName(player.name, 'upper')
      const record = employees.get(normalized)
      if (!record) {
        sendPrivateMessage(player.name, 'You are not currently employed in a job.')
        return
      }
      const report: JobReportLog = {
        time: new Date().toISOString(),
        playerName: record.playerName,
        jobKey: record.jobKey,
        jobName: record.jobName,
        message: reportMessage
      }
      appendJsonLine(reportsPath, report)
        .catch(err => console.error('[Job System] Failed to log report:', err))
      record.lastReportAt = Date.now()
      record.lastFlagAt = null
      saveEmployees().catch(err => console.error('[Job System] Failed to save employees:', err))
      sendPrivateMessage(player.name, 'Report received. Thank you!')
      return
    }

    if (cmd === '/hire' || cmd === '/reject' || cmd === '/fire' || cmd === '/promote' || cmd === '/setpay') {
      if (!isEmployer(player.name)) {
        ex.bot.send('❌ Only employers can use that command.')
        return
      }
    }

    if (cmd === '/hire') {
      const targetName = parts[1]
      const jobInput = parts[2]
      if (!targetName || !jobInput) {
        ex.bot.send('Usage: /hire <playername> <jobposition>')
        return
      }
      const jobKey = normalizeJobInput(jobInput)
      if (!jobKey) {
        ex.bot.send('Unknown job. Use /jobs for the list.')
        return
      }
      const normalized = normalizePlayerName(targetName, 'upper')
      const job = JOBS[jobKey]
      const record: EmployeeRecord = {
        playerName: targetName,
        jobKey: job.key,
        jobName: job.name,
        dailyPay: job.dailyPay,
        hiredAt: Date.now(),
        lastPaidAt: Date.now(),
        lastReportAt: null,
        lastFlagAt: null
      }
      employees.set(normalized, record)
      saveEmployees().catch(err => console.error('[Job System] Failed to save employees:', err))
      const action: JobActionLog = {
        time: new Date().toISOString(),
        action: 'hire',
        actor: player.name,
        playerName: targetName,
        jobKey: job.key,
        jobName: job.name,
        dailyPay: job.dailyPay
      }
      appendJsonLine(actionsPath, action)
        .catch(err => console.error('[Job System] Failed to log action:', err))
      ex.bot.send(`${targetName} hired as ${job.name}.`)
      return
    }

    if (cmd === '/reject') {
      const targetName = parts[1]
      const reason = parts.slice(2).join(' ').trim() || undefined
      if (!targetName) {
        ex.bot.send('Usage: /reject <playername> [reason]')
        return
      }
      const action: JobActionLog = {
        time: new Date().toISOString(),
        action: 'reject',
        actor: player.name,
        playerName: targetName,
        reason
      }
      appendJsonLine(actionsPath, action)
        .catch(err => console.error('[Job System] Failed to log action:', err))
      ex.bot.send(`${targetName} application rejected.`)
      return
    }

    if (cmd === '/fire') {
      const targetName = parts[1]
      const reason = parts.slice(2).join(' ').trim() || undefined
      if (!targetName) {
        ex.bot.send('Usage: /fire <playername> [reason]')
        return
      }
      const normalized = normalizePlayerName(targetName, 'upper')
      const record = employees.get(normalized)
      if (record) {
        employees.delete(normalized)
        saveEmployees().catch(err => console.error('[Job System] Failed to save employees:', err))
      }
      const action: JobActionLog = {
        time: new Date().toISOString(),
        action: 'fire',
        actor: player.name,
        playerName: targetName,
        jobKey: record?.jobKey,
        jobName: record?.jobName,
        reason
      }
      appendJsonLine(actionsPath, action)
        .catch(err => console.error('[Job System] Failed to log action:', err))
      ex.bot.send(`${targetName} has been removed from their job.`)
      return
    }

    if (cmd === '/promote' || cmd === '/setpay') {
      const targetName = parts[1]
      const amountStr = parts[2]
      if (!targetName || !amountStr) {
        ex.bot.send(`Usage: ${cmd} <playername> <newDailyPay>`)
        return
      }
      const newPay = parseInt(amountStr, 10)
      if (Number.isNaN(newPay) || newPay <= 0) {
        ex.bot.send('Invalid pay amount.')
        return
      }
      const normalized = normalizePlayerName(targetName, 'upper')
      const record = employees.get(normalized)
      if (!record) {
        ex.bot.send('Player is not currently employed.')
        return
      }
      record.dailyPay = newPay
      saveEmployees().catch(err => console.error('[Job System] Failed to save employees:', err))
      const action: JobActionLog = {
        time: new Date().toISOString(),
        action: 'promote',
        actor: player.name,
        playerName: targetName,
        jobKey: record.jobKey,
        jobName: record.jobName,
        dailyPay: newPay
      }
      appendJsonLine(actionsPath, action)
        .catch(err => console.error('[Job System] Failed to log action:', err))
      ex.bot.send(`${targetName} pay updated to ${newPay} tokens/day.`)
      return
    }
  })

  let reportTimer: NodeJS.Timeout | null = null
  let payTimer: NodeJS.Timeout | null = null

  const startTimers = () => {
    reportTimer = setInterval(() => {
      flagMissingReports().catch(err => console.error('[Job System] Flag check failed:', err))
    }, 6 * 60 * 60 * 1000)

    payTimer = setInterval(() => {
      runDailyPay().catch(err => console.error('[Job System] Daily pay failed:', err))
    }, 60 * 60 * 1000)
  }

  loadEmployees().then(() => {
    startTimers()
  })

  ex.remove = () => {
    if (reportTimer) clearInterval(reportTimer)
    if (payTimer) clearInterval(payTimer)
    console.log('Job System stopped')
  }
})

const { Client } = require('discord.js-selfbot-v13')
const fs = require('fs')
const path = require('path')

const DISBOARD_BOT_ID = '302050872383242240'
const ONE_HOUR_MS = 60 * 60 * 1000
const TWO_HOURS_MS = 2 * 60 * 60 * 1000  // 7,200,000 ms
const DEFAULT_BUMP_INTERVAL_MS = ONE_HOUR_MS
const RANDOM_DELAY_MS = 5 * 60 * 1000     // 5 minutes random buffer
const PREFIX = '.'

// Read tokens from tokens.txt (one token per line)
const tokensPath = path.join(__dirname, 'tokens.txt')
const idsPath = path.join(__dirname, 'id.txt')

if (!fs.existsSync(tokensPath)) {
    console.error('ERROR: tokens.txt not found!')
    console.error('Create tokens.txt with one token per line')
    process.exit(1)
}

if (!fs.existsSync(idsPath)) {
    console.error('ERROR: id.txt not found!')
    console.error('Create id.txt with one server ID per line')
    process.exit(1)
}

const tokens = fs.readFileSync(tokensPath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))

const serverIds = fs.readFileSync(idsPath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))

if (tokens.length === 0) {
    console.error('ERROR: No tokens found in tokens.txt')
    process.exit(1)
}

if (serverIds.length === 0) {
    console.error('ERROR: No server IDs found in id.txt')
    process.exit(1)
}

if (tokens.length !== serverIds.length) {
    console.error(`ERROR: Mismatch! ${tokens.length} tokens but ${serverIds.length} server IDs`)
    console.error('Each token needs exactly one server ID')
    process.exit(1)
}

// Store all bot instances
const bots = []
const serverState = new Map()

// Pair tokens with server IDs
for (let i = 0; i < tokens.length; i++) {
    bots.push({ 
        index: i,
        token: tokens[i], 
        serverId: serverIds[i], 
        client: null, 
        guild: null,
        channel: null,  // Channel to bump in (set when .b is run)
        bumping: false, 
        bumpTimer: null 
    })
    if (!serverState.has(serverIds[i])) {
        serverState.set(serverIds[i], {
            lastBumpAt: null,
            nextBumpAt: null,
            channelId: null,
            lastHandledMessageId: null
        })
    }
}

console.log(`Loaded ${bots.length} bot(s) - auto-paired tokens with server IDs`)

// Start all bots
async function startBots() {
    for (let i = 0; i < bots.length; i++) {
        const bot = bots[i]
        const client = new Client()
        bot.client = client

        client.on('ready', async () => {
            console.log(`[Bot ${i + 1}] Logged in as ${client.user.tag}`)
            
            try {
                bot.guild = await client.guilds.fetch(bot.serverId)
                console.log(`[Bot ${i + 1}] Assigned to server: ${bot.guild.name}`)
            } catch (err) {
                console.error(`[Bot ${i + 1}] Could not fetch server ${bot.serverId}: ${err.message}`)
            }
        })

        // Handle commands - responds to ANY user in the assigned server
        client.on('messageCreate', async (message) => {
            if (!message.guild) return
            if (!message.content.startsWith(PREFIX)) return
            
            // Only respond to commands in the assigned server
            if (message.guild.id !== bot.serverId) return

            const args = message.content.slice(PREFIX.length).trim().split(/ +/)
            const command = args.shift().toLowerCase()

            // .b - Start bumping in this channel
            if (command === 'b') {
                await message.delete().catch(() => {})

                // Sync all bots in this server to the same channel
                const sameServerBots = bots.filter(b => b.serverId === bot.serverId)
                for (const b of sameServerBots) {
                    b.channel = message.channel
                    b.bumping = true
                }

                console.log(`[${client.user.tag}] Starting bump loop for ${bot.guild?.name} in #${message.channel.name}...`)

                // Bump immediately using the bot that received the command
                await sendBump(bot)

                // Schedule next bumps for everyone in this server
                scheduleNextBumpForServer(bot.serverId, DEFAULT_BUMP_INTERVAL_MS, 'manual start')
            }

            // .stop - Stop bumping
            if (command === 'stop') {
                await message.delete().catch(() => {})

                const sameServerBots = bots.filter(b => b.serverId === bot.serverId)
                for (const b of sameServerBots) {
                    if (b.bumpTimer) {
                        clearTimeout(b.bumpTimer)
                        b.bumpTimer = null
                    }
                    b.bumping = false
                }
                console.log(`[${client.user.tag}] Stopped bumping for ${bot.guild?.name}.`)
            }

            // .setup [invite_link] - Delete all channels, create info channel with invite, create private bump channel
            if (command === 'setup') {
                await message.delete().catch(() => {})
                const inviteLink = args[0]
                
                if (!inviteLink) {
                    console.log(`[${client.user.tag}] Usage: .setup <invite_link>`)
                    return
                }

                const guild = message.guild
                if (!guild) return

                console.log(`[${client.user.tag}] Running setup on ${guild.name}...`)

                try {
                    // Stop bumping first since channels will be deleted
                    if (bot.bumpTimer) {
                        clearTimeout(bot.bumpTimer)
                        bot.bumpTimer = null
                    }
                    bot.bumping = false
                    bot.channel = null

                    // Delete all channels
                    const channels = guild.channels.cache.filter(c => c.deletable)
                    for (const [, channel] of channels) {
                        await channel.delete().catch(() => {})
                        await new Promise(r => setTimeout(r, 500))
                    }

                    // Create info channel (public)
                    const infoChannel = await guild.channels.create('info', {
                        type: 'GUILD_TEXT',
                        topic: 'Server Information',
                        permissionOverwrites: [
                            {
                                id: guild.id, // @everyone role
                                deny: ['SEND_MESSAGES']
                            }
                        ]
                    })

                    // Send invite link
                    await infoChannel.send(inviteLink)
                    
                    // Create private bump channel (only visible to admins/owner)
                    const bumpChannel = await guild.channels.create('bump', {
                        type: 'GUILD_TEXT',
                        topic: 'Auto-bump channel',
                        permissionOverwrites: [
                            {
                                id: guild.id, // @everyone role
                                deny: ['VIEW_CHANNEL', 'SEND_MESSAGES']
                            },
                            {
                                id: guild.ownerId, // Server owner
                                allow: ['VIEW_CHANNEL', 'SEND_MESSAGES']
                            },
                            {
                                id: client.user.id, // The bot itself
                                allow: ['VIEW_CHANNEL', 'SEND_MESSAGES']
                            }
                        ]
                    })
                    
                    // Also give access to users with Administrator permission
                    const adminRole = guild.roles.cache.find(r => r.permissions.has('ADMINISTRATOR') && r.id !== guild.id)
                    if (adminRole) {
                        await bumpChannel.permissionOverwrites.create(adminRole, {
                            VIEW_CHANNEL: true,
                            SEND_MESSAGES: true
                        }).catch(() => {})
                    }
                    
                    console.log(`[${client.user.tag}] Setup complete! Created #info with invite and private #bump channel.`)
                    console.log(`[${client.user.tag}] Use .b in #bump to start bumping.`)
                } catch (err) {
                    console.error(`[${client.user.tag}] Setup failed: ${err.message}`)
                }
            }

            // .status - Show status
            if (command === 'status') {
                await message.delete().catch(() => {})
                console.log(`\n=== Bot Status ===`)
                for (let j = 0; j < bots.length; j++) {
                    const b = bots[j]
                    const status = b.bumping ? 'BUMPING' : 'IDLE'
                    const server = b.guild?.name || 'Not assigned'
                    const channel = b.channel?.name || 'None'
                    const user = b.client?.user?.tag || 'Not logged in'
                    console.log(`[Bot ${j + 1}] ${user} | ${server} | #${channel} | ${status}`)
                }
                console.log(`==================\n`)
            }
        })

        // Watch DISBOARD responses to keep bump timers in sync
        client.on('messageCreate', async (message) => {
            if (!message.guild) return
            if (message.author?.id !== DISBOARD_BOT_ID) return
            if (message.guild.id !== bot.serverId) return

            const state = serverState.get(bot.serverId)
            if (!state || state.lastHandledMessageId === message.id) return
            state.lastHandledMessageId = message.id

            const waitMs = extractWaitMs(message)
            const isBumpDone = isBumpDoneMessage(message)

            if (message.channel?.id) {
                state.channelId = message.channel.id
            }

            if (isBumpDone) {
                state.lastBumpAt = Date.now()
                scheduleNextBumpForServer(bot.serverId, TWO_HOURS_MS, 'bump done')
                return
            }

            if (waitMs !== null) {
                scheduleNextBumpForServer(bot.serverId, waitMs, 'cooldown detected')
            }
        })

        client.on('error', (err) => {
            console.error(`[Bot ${i + 1}] Error: ${err.message}`)
        })

        // Login
        try {
            await client.login(bot.token)
        } catch (err) {
            console.error(`[Bot ${i + 1}] Login failed: ${err.message}`)
        }

        // Small delay between logins
        await new Promise(r => setTimeout(r, 2000))
    }
}

async function sendBump(bot) {
    if (!bot.channel) {
        console.error(`[${bot.client?.user?.tag}] No channel set! Run .b in a channel first.`)
        return false
    }
    
    try {
        // Verify channel still exists
        const channel = await bot.client.channels.fetch(bot.channel.id).catch(() => null)
        if (!channel) {
            console.error(`[${bot.client.user.tag}] Channel no longer exists! Run .b in a new channel.`)
            bot.channel = null
            bot.bumping = false
            if (bot.bumpTimer) {
                clearTimeout(bot.bumpTimer)
                bot.bumpTimer = null
            }
            return false
        }
        
        const timestamp = new Date().toLocaleString()
        console.log(`[${timestamp}] [${bot.client.user.tag}] Sending /bump to ${bot.guild?.name}...`)
        await channel.sendSlash(DISBOARD_BOT_ID, 'bump')
        console.log(`[${timestamp}] [${bot.client.user.tag}] /bump sent!`)
        return true
    } catch (err) {
        console.error(`[${bot.client.user.tag}] /bump failed: ${err.message}`)
        // Don't crash, just stop bumping if channel is gone
        if (err.code === 10003) { // Unknown Channel
            console.error(`[${bot.client.user.tag}] Channel was deleted. Stopping bump loop.`)
            bot.bumping = false
            bot.channel = null
            if (bot.bumpTimer) {
                clearTimeout(bot.bumpTimer)
                bot.bumpTimer = null
            }
        }
        return false
    }
}

function scheduleNextBumpForServer(serverId, delayMs, reason) {
    const state = serverState.get(serverId)
    if (!state) return

    const nextDelay = Math.max(10 * 1000, delayMs + Math.floor(Math.random() * RANDOM_DELAY_MS))
    state.nextBumpAt = Date.now() + nextDelay

    const sameServerBots = bots.filter(b => b.serverId === serverId)
    for (const b of sameServerBots) {
        if (!b.bumping) continue

        if (b.bumpTimer) {
            clearTimeout(b.bumpTimer)
            b.bumpTimer = null
        }

        b.bumpTimer = setTimeout(async () => {
            if (!b.bumping) return

            const leader = getLeaderBot(serverId)
            if (!leader || leader.index !== b.index) return

            await sendBump(b)
            scheduleNextBumpForServer(serverId, DEFAULT_BUMP_INTERVAL_MS, 'default cycle')
        }, nextDelay)
    }

    const leader = getLeaderBot(serverId)
    if (leader?.client?.user?.tag) {
        const nextBumpTime = new Date(state.nextBumpAt)
        console.log(`[${leader.client.user.tag}] Next bump at: ${nextBumpTime.toLocaleString()} (${reason})`)
    }
}

function getLeaderBot(serverId) {
    const sameServerBots = bots.filter(b => b.serverId === serverId)
    return sameServerBots.find(b => b.bumping && b.channel)
}

function isBumpDoneMessage(message) {
    const text = extractMessageText(message)
    return text.includes('bump done') || text.includes('successfully bumped')
}

function extractWaitMs(message) {
    const text = extractMessageText(message)
    const waitMatch = text.match(/wait\s+(?:another\s+)?(?:(\d+)\s*hour[s]?)?\s*(?:(\d+)\s*minute[s]?)?/)
    if (!waitMatch) return null

    const hours = waitMatch[1] ? parseInt(waitMatch[1], 10) : 0
    const minutes = waitMatch[2] ? parseInt(waitMatch[2], 10) : 0
    if (hours === 0 && minutes === 0) return null

    return (hours * 60 * 60 * 1000) + (minutes * 60 * 1000)
}

function extractMessageText(message) {
    const parts = []
    if (message.content) parts.push(message.content)
    if (message.embeds && message.embeds.length > 0) {
        for (const embed of message.embeds) {
            if (embed.title) parts.push(embed.title)
            if (embed.description) parts.push(embed.description)
            if (embed.footer?.text) parts.push(embed.footer.text)
        }
    }
    return parts.join(' ').toLowerCase()
}

// Start
console.log('Starting Disboard Auto-Bump Selfbot...')
console.log('Commands: .b (start bumping), .stop (stop), .setup <invite>, .status')
console.log('')
startBots()

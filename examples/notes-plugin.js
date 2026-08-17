// A third-party plugin that uses all three registration points and two granted
// capabilities. Installed into a running deployment; never compiled in.
export function apply(ctx, config) {
  const root = config.root ?? '/workspace/.notes'

  // A tool that reaches the harness for filesystem access.
  ctx.tools.register({
    name: 'save_note',
    description: 'Save a short note into the workspace so it survives the turn.',
    parameters: {
      title: { type: 'string', required: true, description: 'File name without extension.' },
      body: { type: 'string', required: true, description: 'What to write.' },
    },
    async execute(args) {
      await ctx.harness.runCommand('mkdir -p ' + root)
      const path = root + '/' + String(args.title).replace(/[^A-Za-z0-9._-]/g, '_') + '.md'
      await ctx.harness.writeFile(path, args.body)
      return 'saved ' + path
    },
  })

  // A tool that reads back, to prove fs:read separately from fs:write.
  ctx.tools.register({
    name: 'list_notes',
    description: 'List the notes saved so far.',
    parameters: {},
    async execute() {
      try {
        const entries = await ctx.harness.listDir(root)
        return entries.length === 0
          ? 'no notes yet'
          : entries.map((e) => e.name + ' (' + e.size + ' bytes)').join('\n')
      } catch (error) {
        return 'no notes yet (' + String(error.message).slice(0, 60) + ')'
      }
    },
  })

  // A slash command.
  ctx.commands.register({
    name: 'notes',
    description: 'Show where this plugin keeps its notes.',
    async execute() {
      return 'notes live in ' + root
    },
  })

  // A dynamic system prompt section: computed on every assembly, in the plugin.
  ctx.systemPrompt.section({
    name: 'notes-hint',
    order: 450,
    text: async (context) => {
      return 'A notes plugin is installed. Save durable notes with save_note; they land in '
        + root + '. (session ' + (context.sessionId ?? 'unknown') + ')'
    },
  })
}

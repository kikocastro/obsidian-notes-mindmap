A self-contained demo of the **Markdown Mindmap** plugin. It reads only the notes under
`mindmap-demo/` and does not touch the strategy tree. Open this note in Obsidian (Reading or
Live Preview) to see the rendered map.

Try: hover a node to highlight its lineage, click a node to open a dialog with its linked
parents/children and the note, use the **−** button to collapse a subtree, and the **status**
chips to filter (multi-select). The task cards show a progress bar.

```mindmap
title: Demo · Goals → Projects → Tasks
levels:
  - id: goals
    label: GOALS
    from: mindmap-demo/goals
    color: "#4f9dff"
    card:
      title: title
      sub: kpi
  - id: projects
    label: PROJECTS
    from: mindmap-demo/projects
    color: "#46b863"
    card:
      title: title
      meta: [status]
  - id: tasks
    label: TASKS
    from: mindmap-demo/tasks
    color: "#e0922e"
    card:
      title: title
      meta: [status]
      progress: progress
edges:
  - from: goals
    to: projects
    via: goal
  - from: projects
    to: tasks
    via: project
filter: [status]
```

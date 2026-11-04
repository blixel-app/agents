// Stands in for `@opencode/plugin` and `@opencode/plugin/tui`, which only OpenCode's own
// binary carries. OpenCode 2.2.5 loads a plugin module's default `{ id, setup }`, so
// `define` hands it back; a skill's branded fields are plain values here.
const same = <T>(value: T) => value

export const Plugin = { define: same }

export const Skill = {
  Info: { make: same, fields: { path: { make: same } } },
  ID: { make: same },
  Name: { make: same },
}

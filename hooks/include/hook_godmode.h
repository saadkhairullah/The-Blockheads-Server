#ifndef HOOK_GODMODE_H
#define HOOK_GODMODE_H

// Defense: damage reduction (0-100%). 100% = full god mode.
void SetDefense(unsigned long long uid, float value);
float GetDefense(unsigned long long uid);

// Buff: attack multiplier (0-100x). 0 = remove buff.
void SetBuff(unsigned long long uid, float value);
float GetBuff(unsigned long long uid);

// Legacy god mode toggle (sets defense to 100% or 0%)
bool ToggleGodModeId(unsigned long long uid);

// Init hooks
void InitGodModeHooks(void);

#endif // HOOK_GODMODE_H

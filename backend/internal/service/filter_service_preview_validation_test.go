package service_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"krss/backend/internal/model"
	"krss/backend/internal/service"
)

// 52-6（用户第 6 条「创建自动化时，如果没有输入标题，也是可以预览的」）：
// 预览是 dry-run、不落库，名称对它没有任何意义 ⇒ 校验要分两层：
// 保存 = ValidateFilterParams（含名称），预览 = ValidateFilterParamsBody（不含名称）。
// 除名称以外的一切（条件/动作/范围/互斥）两边都必须一样严 —— 否则「预览通过、保存报错」
// 会把用户引到一个假绿上。
func TestValidateFilterParams_PreviewDoesNotRequireName(t *testing.T) {
	conditions := []model.FilterCondition{
		{Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助"},
	}
	actions := model.FilterActions{Mute: true}

	noName := service.FilterWriteParams{
		Name: "   ", Kind: model.FilterKindRule, ScopeType: model.FilterScopeAll,
		Conditions: conditions, Actions: actions,
	}

	// 预览口径：无名字也过
	require.NoError(t, service.ValidateFilterParamsBody(noName))
	// 保存口径：仍然拦空名字
	require.ErrorIs(t, service.ValidateFilterParams(noName), service.ErrInvalidFilter)

	// 名字填上，两边都过
	named := noName
	named.Name = "屏蔽赞助"
	require.NoError(t, service.ValidateFilterParamsBody(named))
	require.NoError(t, service.ValidateFilterParams(named))
}

// 52-6 反向保证：放开名称**没有**顺带放开别的校验。
func TestValidateFilterParamsBody_StillChecksEverythingElse(t *testing.T) {
	condition := model.FilterCondition{
		Field: model.FilterFieldTitle, Operator: model.FilterOpContains, Value: "赞助",
	}

	// 规则没有任何动作 → 预览也该拦（预览的意义之一就是让你看清「这条会动到谁」）
	require.ErrorIs(t, service.ValidateFilterParamsBody(service.FilterWriteParams{
		Kind: model.FilterKindRule, ScopeType: model.FilterScopeAll,
		Conditions: []model.FilterCondition{condition},
	}), service.ErrInvalidFilter)

	// 视图没有条件 → 拦
	require.ErrorIs(t, service.ValidateFilterParamsBody(service.FilterWriteParams{
		Kind: model.FilterKindView, ScopeType: model.FilterScopeAll,
	}), service.ErrInvalidFilter)

	// 视图带动作 → 拦
	require.ErrorIs(t, service.ValidateFilterParamsBody(service.FilterWriteParams{
		Kind: model.FilterKindView, ScopeType: model.FilterScopeAll,
		Conditions: []model.FilterCondition{condition},
		Actions:    model.FilterActions{Mute: true},
	}), service.ErrInvalidFilter)

	// 订阅范围缺 scopeId → 拦
	require.ErrorIs(t, service.ValidateFilterParamsBody(service.FilterWriteParams{
		Kind: model.FilterKindRule, ScopeType: model.FilterScopeFeed,
		Conditions: []model.FilterCondition{condition},
		Actions:    model.FilterActions{Mute: true},
	}), service.ErrInvalidFilter)

	// mute + keepOnly 互斥 → 拦
	require.ErrorIs(t, service.ValidateFilterParamsBody(service.FilterWriteParams{
		Kind: model.FilterKindRule, ScopeType: model.FilterScopeAll,
		Conditions: []model.FilterCondition{condition},
		Actions:    model.FilterActions{Mute: true, KeepOnly: true},
	}), service.ErrInvalidFilter)
}

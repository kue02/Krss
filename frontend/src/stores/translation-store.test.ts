import { describe, it, expect, beforeEach } from "vitest";
import {
  useTranslationStore,
  getCacheKey,
  translationActions,
} from "./translation-store";

describe("translation-store", () => {
  beforeEach(() => {
    // Reset store state
    useTranslationStore.setState({ data: {}, disabled: new Set(), statuses: {} });
  });

  describe("getCacheKey", () => {
    it("should return language for normal mode", () => {
      expect(getCacheKey("en", false)).toBe("en");
      expect(getCacheKey("zh-CN", false)).toBe("zh-CN");
    });

    it("should return language:readability for readability mode", () => {
      expect(getCacheKey("en", true)).toBe("en:readability");
      expect(getCacheKey("zh-CN", true)).toBe("zh-CN:readability");
    });
  });

  describe("setTranslation", () => {
    it("should set translation for article", () => {
      useTranslationStore.getState().setTranslation("article1", "en", {
        title: "Translated Title",
        summary: "Translated Summary",
      });

      const state = useTranslationStore.getState();
      expect(state.data["article1"]?.["en"]).toEqual({
        title: "Translated Title",
        summary: "Translated Summary",
        content: null,
      });
    });

    it("should merge partial translation", () => {
      useTranslationStore.getState().setTranslation("article1", "en", {
        title: "Title",
      });
      useTranslationStore.getState().setTranslation("article1", "en", {
        content: "Content",
      });

      const translation =
        useTranslationStore.getState().data["article1"]?.["en"];
      expect(translation?.title).toBe("Title");
      expect(translation?.content).toBe("Content");
    });

    it("should handle readability mode separately", () => {
      useTranslationStore.getState().setTranslation(
        "article1",
        "en",
        {
          content: "Normal content",
        },
        false,
      );
      useTranslationStore.getState().setTranslation(
        "article1",
        "en",
        {
          content: "Readability content",
        },
        true,
      );

      const state = useTranslationStore.getState();
      expect(state.data["article1"]?.["en"]?.content).toBe("Normal content");
      expect(state.data["article1"]?.["en:readability"]?.content).toBe(
        "Readability content",
      );
    });
  });

  describe("getTranslation", () => {
    beforeEach(() => {
      useTranslationStore.getState().setTranslation("article1", "en", {
        title: "Test Title",
        summary: "Test Summary",
        content: "Test Content",
      });
    });

    it("should get translation", () => {
      const translation = useTranslationStore
        .getState()
        .getTranslation("article1", "en");
      expect(translation?.title).toBe("Test Title");
    });

    it("should return undefined for non-existent article", () => {
      const translation = useTranslationStore
        .getState()
        .getTranslation("nonexistent", "en");
      expect(translation).toBeUndefined();
    });

    it("should return undefined if translation is disabled", () => {
      useTranslationStore.getState().disableTranslation("article1");
      const translation = useTranslationStore
        .getState()
        .getTranslation("article1", "en");
      expect(translation).toBeUndefined();
    });
  });

  describe("clearTranslation", () => {
    it("should clear translation for article", () => {
      useTranslationStore
        .getState()
        .setTranslation("article1", "en", { title: "Test" });
      useTranslationStore.getState().clearTranslation("article1");

      const state = useTranslationStore.getState();
      expect(state.data["article1"]).toBeUndefined();
    });

    it("should not affect other articles", () => {
      useTranslationStore
        .getState()
        .setTranslation("article1", "en", { title: "Test1" });
      useTranslationStore
        .getState()
        .setTranslation("article2", "en", { title: "Test2" });
      useTranslationStore.getState().clearTranslation("article1");

      const state = useTranslationStore.getState();
      expect(state.data["article1"]).toBeUndefined();
      expect(state.data["article2"]?.["en"]?.title).toBe("Test2");
    });
  });

  describe("disableTranslation", () => {
    it("should disable translation for article", () => {
      useTranslationStore.getState().disableTranslation("article1");
      expect(useTranslationStore.getState().isDisabled("article1")).toBe(true);
    });

    it("should clear existing translation data", () => {
      useTranslationStore
        .getState()
        .setTranslation("article1", "en", { title: "Test" });
      useTranslationStore.getState().disableTranslation("article1");

      const state = useTranslationStore.getState();
      expect(state.data["article1"]).toBeUndefined();
    });
  });

  describe("enableTranslation", () => {
    it("should enable translation for article", () => {
      useTranslationStore.getState().disableTranslation("article1");
      useTranslationStore.getState().enableTranslation("article1");
      expect(useTranslationStore.getState().isDisabled("article1")).toBe(false);
    });
  });

  describe("isDisabled", () => {
    it("should return false for non-disabled article", () => {
      expect(useTranslationStore.getState().isDisabled("article1")).toBe(false);
    });

    it("should return true for disabled article", () => {
      useTranslationStore.getState().disableTranslation("article1");
      expect(useTranslationStore.getState().isDisabled("article1")).toBe(true);
    });
  });

  describe("translationActions", () => {
    it("should provide external access to store methods", () => {
      translationActions.set("article1", "en", { title: "Test" });
      expect(translationActions.get("article1", "en")?.title).toBe("Test");

      translationActions.disable("article1");
      expect(translationActions.isDisabled("article1")).toBe(true);

      translationActions.enable("article1");
      expect(translationActions.isDisabled("article1")).toBe(false);

      translationActions.set("article2", "en", { title: "Test2" });
      translationActions.clear("article2");
      expect(translationActions.get("article2", "en")).toBeUndefined();
    });
  });

  describe("statuses (REQ3)", () => {
    it("stores content / summary states per entry+language without touching data", () => {
      translationActions.setStatus("article1", "en", {
        content: { state: "translating" },
        summary: { state: "translating" },
      });
      expect(translationActions.getStatus("article1", "en")).toEqual({
        content: { state: "translating" },
        summary: { state: "translating" },
      });
      // 过程状态不污染内容缓存
      expect(useTranslationStore.getState().data["article1"]).toBeUndefined();
    });

    it("shallow-merges patch and can clear a single field with null", () => {
      translationActions.setStatus("article1", "en", {
        content: { state: "translating" },
        summary: { state: "translating" },
      });
      translationActions.setStatus("article1", "en", {
        content: { state: "done" },
      });
      translationActions.setStatus("article1", "en", { summary: null });
      expect(translationActions.getStatus("article1", "en")).toEqual({
        content: { state: "done" },
      });
    });

    it("drops the key entirely when both fields are cleared", () => {
      translationActions.setStatus("article1", "en", {
        content: { state: "failed", error: "boom" },
      });
      translationActions.setStatus("article1", "en", { content: null });
      expect(translationActions.getStatus("article1", "en")).toBeUndefined();
    });

    it("clearStatus without language clears every language", () => {
      translationActions.setStatus("article1", "en", {
        content: { state: "done" },
      });
      translationActions.setStatus("article1", "ja", {
        content: { state: "done" },
      });
      translationActions.clearStatus("article1");
      expect(translationActions.getStatus("article1", "en")).toBeUndefined();
      expect(translationActions.getStatus("article1", "ja")).toBeUndefined();
    });
  });
});

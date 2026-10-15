from comfy_api.latest import io
from comfy_api.latest._io import ComfyTypeIO, WidgetInput, comfytype


@comfytype(io_type="SUPERUI_DYNAMIC_TEXT")
class DynamicTextWidget(ComfyTypeIO):
    # Drawn by web/js/dynamic_text.js. The frontend strips comments and
    # resolves {a|b} choices when queueing, so the value that reaches the
    # backend is already final text.
    Type = str

    class Input(WidgetInput):
        def __init__(
            self,
            id: str,
            display_name: str = None,
            tooltip: str = None,
            default: str = "",
        ):
            super().__init__(
                id, display_name, False, tooltip, None, default, True
            )


class DynamicText(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="SuperUIDynamicText",
            display_name="🐧 Dynamic Text Entry",
            category="SuperUI/Text",
            description="Multiline text with comments and {a|b} dynamic prompts.",
            search_aliases=[
                "text",
                "multiline",
                "prompt",
                "dynamic prompts",
                "wildcard",
                "comments",
            ],
            inputs=[
                DynamicTextWidget.Input("text"),
                # Only shown, and only stepped on queue, while the text has
                # a {a|b} choice; otherwise it would invalidate the cache of
                # everything downstream for no reason.
                io.Int.Input(
                    "seed",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    control_after_generate=True,
                    tooltip="Picks the {a|b} choices.",
                ),
            ],
            outputs=[io.String.Output()],
        )

    @classmethod
    def execute(cls, text: str, seed: int) -> io.NodeOutput:
        return io.NodeOutput(text)


NODE = [DynamicText]

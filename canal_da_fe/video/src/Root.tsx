import React from "react";
import { Composition, staticFile } from "remotion";
import { ShortsReligioso } from "./ShortsReligioso";
import { VideoMetadata } from "./types";

const FPS = 30;

export const Root: React.FC = () => {
    return (
        <>
            <Composition
                id="ShortsReligioso"
                component={ShortsReligioso}
                calculateMetadata={async () => {
                    const response = await fetch(staticFile("metadata.json"));
                    const meta: VideoMetadata = await response.json();
                    const totalSeconds = meta.duracao_total_real_s ?? meta.duracao_total_s ?? 49;
                    const durationInFrames = Math.ceil((totalSeconds + 1) * FPS);

                    return {
                        durationInFrames,
                        fps: FPS,
                        width: 1080,
                        height: 1920,
                        props: {},
                    };
                }}
                durationInFrames={FPS * 50}
                fps={FPS}
                width={1080}
                height={1920}
            />
        </>
    );
};

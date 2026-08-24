import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPixelatedPass } from 'three/addons/postprocessing/RenderPixelatedPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GodRaysShader, WeatherGradeShader, BloomShader, WindBlurShader, ZoomBlurShader } from './postfx.js';

export function buildComposer(renderer, scene, camera, pixelSize = 3) {
  const composer = new EffectComposer(renderer);

  const renderPixelatedPass = new RenderPixelatedPass(pixelSize, scene, camera);
  composer.addPass(renderPixelatedPass);

  const godRaysPass = new ShaderPass(GodRaysShader);
  composer.addPass(godRaysPass);

  const bloomPass = new ShaderPass(BloomShader);
  bloomPass.uniforms.resolution.value.set(window.innerWidth, window.innerHeight);
  composer.addPass(bloomPass);

  const weatherGradePass = new ShaderPass(WeatherGradeShader);
  composer.addPass(weatherGradePass);

  const windBlurPass = new ShaderPass(WindBlurShader);
  composer.addPass(windBlurPass);

  const zoomBlurPass = new ShaderPass(ZoomBlurShader);
  composer.addPass(zoomBlurPass);

  composer.addPass(new OutputPass());

  return { composer, renderPixelatedPass, godRaysPass, bloomPass, weatherGradePass, windBlurPass, zoomBlurPass };
}

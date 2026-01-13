const { getCompileCore, compileWithEsbuild } = require('../app/esbuild.js')
const { expect } = require('chai')
const { describe, it, before } = require('mocha')

describe('esbuild.js', () => {
  /** @type {Awaited<ReturnType<typeof getCompileCore>>} */
  let core

  before(async () => {
    core = await getCompileCore()
  })

  describe('exported properties from core module', () => {
    const expectedCoreExports = [
      'PRIMARY_FILES',
      'MASTER_PATH_REPLACEMENTS',
      'isPrimaryFile',
      'getMasterPath',
      'getUMDConfig',
      'replaceFileContent',
      'getDefaultReplacements',
      'applyReplacements',
      'generatePrimaryUMDHeader',
      'generateModuleUMDHeader',
      'generateUMDFooter',
      'getLegacyPlugins',
      'buildEsbuildConfig',
      'compile'
    ]

    it('should have all expected exports from core', () => {
      for (const name of expectedCoreExports) {
        expect(core).to.have.property(name)
      }
    })
  })

  describe('local exports', () => {
    it('should export compileWithEsbuild', () => {
      expect(compileWithEsbuild).to.be.a('function')
    })

    it('should export getCompileCore', () => {
      expect(getCompileCore).to.be.a('function')
    })
  })

  describe('PRIMARY_FILES', () => {
    it('should be an array', () => {
      expect(core.PRIMARY_FILES).to.be.an('array')
    })

    it('should contain highcharts.src.js', () => {
      expect(core.PRIMARY_FILES).to.include('/highcharts.src.js')
    })

    it('should contain highstock.src.js', () => {
      expect(core.PRIMARY_FILES).to.include('/highstock.src.js')
    })

    it('should contain highmaps.src.js', () => {
      expect(core.PRIMARY_FILES).to.include('/highmaps.src.js')
    })

    it('should contain highcharts-gantt.src.js', () => {
      expect(core.PRIMARY_FILES).to.include('/highcharts-gantt.src.js')
    })
  })

  describe('isPrimaryFile', () => {
    it('should return true for /highcharts.src.js', () => {
      expect(core.isPrimaryFile('/highcharts.src.js')).to.equal(true)
    })

    it('should return true for /highstock.src.js', () => {
      expect(core.isPrimaryFile('/highstock.src.js')).to.equal(true)
    })

    it('should return true for /highmaps.src.js', () => {
      expect(core.isPrimaryFile('/highmaps.src.js')).to.equal(true)
    })

    it('should return false for module files', () => {
      expect(core.isPrimaryFile('/modules/exporting.src.js')).to.equal(false)
    })

    it('should return false for random files', () => {
      expect(core.isPrimaryFile('/some-random-file.js')).to.equal(false)
    })
  })

  describe('getMasterPath', () => {
    it('should convert .js to .ts extension', () => {
      const result = core.getMasterPath('/highcharts.src.js', '/path/to/highcharts')
      expect(result).to.include('.ts')
      expect(result).to.not.include('.js')
    })

    it('should include ts/masters in the path', () => {
      const result = core.getMasterPath('/highcharts.src.js', '/path/to/highcharts')
      expect(result).to.include('ts/masters')
    })

    it('should handle module files', () => {
      const result = core.getMasterPath('/modules/exporting.src.js', '/path/to/highcharts')
      expect(result).to.include('ts/masters/modules/exporting.src.ts')
    })
  })

  describe('getUMDConfig', () => {
    it('should return Highcharts config for highcharts files', () => {
      const config = core.getUMDConfig('/highcharts.src.js')
      expect(config.name).to.equal('Highcharts')
      expect(config.isEsModules).to.equal(false)
    })

    it('should return Highcharts config for module files', () => {
      const config = core.getUMDConfig('/modules/exporting.src.js')
      expect(config.name).to.equal('Highcharts')
    })

    it('should return Dashboards config for dashboards files', () => {
      const config = core.getUMDConfig('/dashboards/dashboards.src.js')
      expect(config.name).to.equal('Dashboards')
    })

    it('should return Grid config for grid files', () => {
      const config = core.getUMDConfig('/grid/grid-lite.src.js')
      expect(config.name).to.equal('Grid')
    })

    it('should return Grid config for datagrid files', () => {
      const config = core.getUMDConfig('/dashboards/datagrid.src.js')
      expect(config.name).to.equal('Grid')
    })

    it('should detect es-modules in path', () => {
      const config = core.getUMDConfig('/es-modules/masters/highcharts.src.js')
      expect(config.isEsModules).to.equal(true)
    })
  })

  describe('generatePrimaryUMDHeader', () => {
    it('should generate UMD wrapper with correct global name', () => {
      const config = { name: 'Highcharts', path: 'highcharts/highcharts' }
      const header = core.generatePrimaryUMDHeader(config)

      expect(header).to.include('root.Highcharts')
      expect(header).to.include("define('highcharts/highcharts'")
      expect(header).to.include('module.exports')
    })

    it('should handle Dashboards config', () => {
      const config = { name: 'Dashboards', path: 'dashboards/dashboards' }
      const header = core.generatePrimaryUMDHeader(config)

      expect(header).to.include('root.Dashboards')
    })
  })

  describe('generateModuleUMDHeader', () => {
    it('should generate module UMD wrapper', () => {
      const config = { name: 'Highcharts', shortPath: 'dashboards' }
      const header = core.generateModuleUMDHeader(config, '/modules/exporting.src.js')

      expect(header).to.include("define('/modules/exporting.src.js'")
      expect(header).to.include('Highcharts')
    })
  })

  describe('generateUMDFooter', () => {
    it('should generate primary footer with return statement', () => {
      const config = { name: 'Highcharts', isEsModules: false }
      const footer = core.generateUMDFooter(config, true)

      expect(footer).to.include('return Highcharts')
    })

    it('should generate module footer without return statement', () => {
      const config = { name: 'Highcharts', isEsModules: false }
      const footer = core.generateUMDFooter(config, false)

      expect(footer).to.equal('}));')
    })

    it('should return empty string for es-modules', () => {
      const config = { name: 'Highcharts', isEsModules: true }
      const footer = core.generateUMDFooter(config, true)

      expect(footer).to.equal('')
    })
  })

  describe('getDefaultReplacements', () => {
    it('should return an object with replacement mappings', () => {
      const config = { name: 'Highcharts' }
      const replacements = core.getDefaultReplacements(config)

      expect(replacements).to.be.an('object')
      expect(replacements).to.have.property('Core/Globals.ts')
    })

    it('should include Globals replacement with correct namespace', () => {
      const config = { name: 'Highcharts' }
      const replacements = core.getDefaultReplacements(config)

      expect(replacements['Core/Globals.ts']).to.include('Highcharts')
    })

    it('should include Utilities replacement for non-Dashboards', () => {
      const config = { name: 'Highcharts' }
      const replacements = core.getDefaultReplacements(config)

      expect(replacements).to.have.property('Core/Utilities.ts')
    })

    it('should not include Utilities replacement for Dashboards', () => {
      const config = { name: 'Dashboards' }
      const replacements = core.getDefaultReplacements(config)

      expect(replacements).to.not.have.property('Core/Utilities.ts')
    })
  })

  describe('buildEsbuildConfig', () => {
    it('should return esbuild config object', () => {
      const config = core.buildEsbuildConfig(
        '/path/to/master.ts',
        { name: 'Highcharts', isEsModules: false, filename: '/highcharts.src.js' },
        true,
        []
      )

      expect(config).to.have.property('entryPoints')
      expect(config).to.have.property('bundle')
      expect(config).to.have.property('write')
      expect(config).to.have.property('globalName')
      expect(config).to.have.property('plugins')
      expect(config).to.have.property('banner')
      expect(config).to.have.property('footer')
    })

    it('should set bundle to true for non-es-modules', () => {
      const config = core.buildEsbuildConfig(
        '/path/to/master.ts',
        { name: 'Highcharts', isEsModules: false, filename: '/highcharts.src.js' },
        true,
        []
      )

      expect(config.bundle).to.equal(true)
    })

    it('should set bundle to false for es-modules', () => {
      const config = core.buildEsbuildConfig(
        '/path/to/master.ts',
        { name: 'Highcharts', isEsModules: true, filename: '/highcharts.src.js' },
        true,
        []
      )

      expect(config.bundle).to.equal(false)
    })

    it('should set write to false (we handle output ourselves)', () => {
      const config = core.buildEsbuildConfig(
        '/path/to/master.ts',
        { name: 'Highcharts', isEsModules: false, filename: '/highcharts.src.js' },
        true,
        []
      )

      expect(config.write).to.equal(false)
    })

    it('should include banner with UMD header for non-es-modules', () => {
      const config = core.buildEsbuildConfig(
        '/path/to/master.ts',
        { name: 'Highcharts', isEsModules: false, path: 'highcharts/highcharts', filename: '/highcharts.src.js' },
        true,
        []
      )

      expect(config.banner.js).to.include('root.Highcharts')
    })

    it('should have empty banner for es-modules', () => {
      const config = core.buildEsbuildConfig(
        '/path/to/master.ts',
        { name: 'Highcharts', isEsModules: true, filename: '/highcharts.src.js' },
        true,
        []
      )

      expect(config.banner.js).to.equal('')
    })
  })

  describe('MASTER_PATH_REPLACEMENTS', () => {
    it('should be an array of replacement rules', () => {
      expect(core.MASTER_PATH_REPLACEMENTS).to.be.an('array')
      expect(core.MASTER_PATH_REPLACEMENTS.length).to.be.greaterThan(0)
    })

    it('should include .js to .ts replacement', () => {
      const hasJsToTsRule = core.MASTER_PATH_REPLACEMENTS.some(
        ([from]) => from instanceof RegExp && from.test('.js')
      )
      expect(hasJsToTsRule).to.equal(true)
    })
  })
})

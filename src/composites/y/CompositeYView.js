/*
 * Copyright (c) Juniper Networks, Inc. All rights reserved.
 */
import _ from 'lodash'
import * as d3Selection from 'd3-selection'
import * as d3Array from 'd3-array'
import ChartView from 'chart-view'
import Config from './CompositeYConfigModel'
import Model from 'models/DataFrame'
import CompositeChart from 'helpers/CompositeChart'
import actionman from 'core/Actionman'
import SelectColor from '../../actions/SelectColor'
import SelectKey from '../../actions/SelectKey'
import Zoom from '../../actions/Zoom'
import ClusterAction from '../../components/bucket/actions/Cluster'
import SelectChartType from './actions/SelectChartType'
import './y.scss'
/**
 * Creates composited chart with X and Y axes and compatible components like: Line, Area, StackedBar, etc
 */
export default class CompositeYView extends ChartView {
  static get Config () { return Config }
  static get Model () { return Model }
  static get Actions () { return {SelectColor, SelectKey, SelectChartType, Zoom, ClusterAction} }

  constructor (...args) {
    super(...args)
    this._composite = new CompositeChart()
  }

  get tagName () { return 'g' }

  get selectors () {
    return _.extend(super.selectors, {
      node: '.child',
      axis: '.axis',
      clip: 'clipPath',
    })
  }

  render () {
    super.render()
    this._updateComponents()
    this.config.calculateScales(this.model)
    // reset axes ticks
    this.config.set('ticks', {}, {silent: true, unset: true})
    this._renderAxes()
    this._renderClip()

    // force composite scale for children components
    const components = this._composite.getByType(_(this.config.yAccessors).map('chart').uniq().value())
    _.each(components, component => {
      const componentAxis = this.config.getAxisName(component.config.get('y'))
      // TODO even without silent this will not trigger config 'change' because of nested attribute
      component.config.set('x.scale', this.config.get(`axes.x.scale`), {silent: true})
      component.config.set('y.scale', this.config.get(`axes.${componentAxis}.scale`), {silent: true})
      if (this.config.get('bucket') && component.type === 'ScatterPlot') return
      component.render()
    })
    this._cluster()
    this._showLegend()
    this._initCrosshair()
    this._toggleCrosshair()

    this._ticking = false
  }

  remove () {
    this._composite.remove()
    super.remove()
  }
  /**
   * Works only with incremental values at x scale, as range is set as min / max values for x scale
   * There is no option to set zoomed range by exact position at x scale (start / end)
   */
  zoom (ranges) {
    const accessorsByAxis = _.groupBy(this.config.yAccessors, 'axis')
    accessorsByAxis.x = [{accessor: this.config.get('plot.x.accessor')}]

    _.each(accessorsByAxis, (accessors, axisName) => {
      // change domains only for specified accessors or
      // if no ranges specified - reset all
      if (_.isEmpty(_.filter(accessors, a => !ranges || ranges[a.accessor]))) return

      // combine ranges of different accessors on the same axis
      const range = d3Array.extent(_(accessors).map(accessor => {
        return ranges ? ranges[accessor.accessor] : []
      }).flatten().value())

      // Skip equal start-end ranges except they are "undefined"
      if (range[0] !== range[1] || _.isNil(range[0])) {
        this.config.set(`axes.${axisName}.domain`, range, {silent: true})
      }
    })

    this.render()
  }
  /**
   * React on "Cluster" action fired
   */
  cluster (overlapping) {
    this._overlapping = overlapping
    const scatterPlots = this._composite.getByType('ScatterPlot')
    _.each(scatterPlots, component => component.cluster(overlapping))
  }

  _renderClip () {
    let clip = this.d3.select(this.selectors.clip)
    if (clip.empty()) {
      clip = this.d3.append(this.selectors.clip)
        .attr('id', `${this.id}-${this.selectors.clip}`)
      clip.append('rect')
    }
    clip.select('rect').attr('width', this.innerWidth).attr('height', this.innerHeight)
  }
  /**
   * Render axes and calculate inner margins for charts
   */
  _renderAxes () {
    const elements = this.svg.selectAll(this.selectors.axis)
      .data(this.config.activeAxes, d => d.name)

    elements.enter().each(axis => {
      const component = this._composite.add({
        type: 'Axis',
        config: this.config.getAxisConfig(axis.name),
        container: this._container,
      })
      component.el.__data__ = axis
    })

    elements.each(axis => {
      const component = this._composite.get(axis.id)
      // if only a scale is changed Backbone doesn't trigger "change" event and no render will happen
      component.config.set(this.config.getAxisConfig(axis.name), {silent: true})
      component.render()
    })

    elements.exit().each(axis => {
      this._composite.remove(axis.id)
    })
  }
  /**
   * Child components are initialized on the first call
   * Individual component scales are calculated and stored in this.config
   * No rendering here
   */
  _updateComponents (p) {
    const config = {
      // all sub charts should not react on model change as some preparation for them is done here
      frozen: true,
      // TODO add axes space to the chart margins
      margin: this.config.margin,
      width: this.width,
      height: this.height,
      x: {
        accessor: this.config.get('plot.x.accessor'),
        domain: this.config.get('axes.x.domain'),
        scale: this.config.get('axes.x.scale'),
      }
    }
    const children = this.svg.selectAll(this.selectors.node)
      .data(this.config.children, d => d.key)

    // reset calculated values from previous render
    _.each(this.config.activeAxes, axis => {
      this.config.set(`axes.${axis.name}.calculatedDomain`, undefined, {silent: true})
      this.config.set(`axes.${axis.name}.range`, undefined, {silent: true})
    })
    children.enter().merge(children).each(child => this._updateComponent(child, config))

    children.exit().each(child => {
      this._composite.remove(`${this.id}-${child.key}`)
    })
  }

  _updateComponent (child, config) {
    const type = this.config.getComponentType(child.accessors)
    config.id = `${this.id}-${child.key}`
    if (this.config.isMultiAccessor(type)) config.y = child.accessors
    else {
      config.y = child.accessors[0]
      config.tooltip = child.accessors[0].tooltip
    }
    if (type === 'ScatterPlot') config.size = child.accessors[0].size

    let component = this._composite.get(`${this.id}-${child.key}`)
    if (component) component.config.set(config, {silent: true})
    else {
      component = this._composite.add({
        type,
        config,
        model: this.model,
        container: this._container,
      })
      component.d3.classed(this.selectorClass('node'), true)
        .attr('clip-path', `url(#${this.id}-${this.selectors.clip})`)
      component.el.__data__ = {key: child.key}
    }

    // TODO must be a less verbose method to get scale from component (make it calculate)
    component.calculateScales()
    const axisName = this.config.getAxisName(child.accessors)
    let yDomain = this.config.get(`axes.${axisName}.calculatedDomain`) || []
    let xRange = this.config.get(`axes.x.range`) || [0, this.innerWidth]
    let yRange = this.config.get(`axes.${axisName}.range`) || [this.innerHeight, 0]
    yDomain = d3Array.extent(yDomain.concat(component.config.yScale.domain()))
    let componentXRange = component.config.xScale.range()
    let componentYRange = component.config.yScale.range()
    xRange = [Math.max(xRange[0], componentXRange[0]), Math.min(xRange[1], componentXRange[1])]
    yRange = [Math.min(yRange[0], componentYRange[0]), Math.max(yRange[1], componentYRange[1])]

    this.config.set(`axes.${axisName}.calculatedDomain`, yDomain, {silent: true})
    this.config.set(`axes.x.range`, xRange, {silent: true})
    this.config.set(`axes.${axisName}.range`, yRange, {silent: true})
  }

  _initCrosshair () {
    const crosshairId = this.config.get('crosshair')
    if (!crosshairId) return
    this.svg.delegate('mousemove', 'svg', this._onMousemove.bind(this))
  }

  _toggleCrosshair (point) {
    const crosshairId = this.config.get('crosshair')
    if (!point || point[0] < 0 || point[0] > this.innerWidth || point[1] < 0 || point[1] > this.innerHeight) {
      actionman.fire('ToggleVisibility', crosshairId, false)
      this._ticking = false
      return
    }
    const xScale = this.config.get('axes.x.scale')
    const mouseX = xScale.invert(point[0])
    const xAccessor = this.config.get('plot.x.accessor')
    const serie = this.model.getNearest(xAccessor, mouseX)

    const config = {
      container: this._container,
      width: this.width,
      height: this.height,
      margin: this.config.margin,
      bubbles: true,
      lines: 'full',
    }

    const data = {
      hoverPoint: point,
      dataPoint: [],
      item: serie,
      labels: [],
      points: [],
    }

    data.dataPoint[0] = xScale(_.get(serie, xAccessor))
    // TODO if scatterplot - calculate snapped y coord too
    data.dataPoint[1] = point[1]

    data.labels = _.map(this.config.activeAxes, axisConfig => {
      const axis = this._composite.get(`${this.id}-${axisConfig.name}`)
      const accessor = this.config.getAxisAccessors(axisConfig.name)[0]
      let value = _.get(serie, accessor)
      const formatter = axis.config.formatter
      if (formatter) value = formatter(value)
      return {
        position: 'bottom',
        value: value,
      }
    })
    // TODO enable not only for x axis
    data.labels = [data.labels[0]]

    _.each(this.config.children, child => {
      const component = this._composite.get(this.id + '-' + child.key)
      _.each(child.accessors, accessor => {
        const accessorName = accessor.accessor
        data.points.push({
          id: accessorName,
          x: component.getScreenX(serie, accessorName),
          y: component.getScreenY(serie, accessorName),
          color: this.config.getColor(accessorName),
        })
      })
    })

    actionman.fire('ToggleVisibility', crosshairId, true, data, config)
    this._ticking = false
  }

  _showLegend () {
    const legendId = this.config.get('legend')
    if (!legendId) return

    const config = {
      colorScheme: this.config.get('colorScheme'),
      chartTypes: this.config.get('chartTypes'),
    }
    const data = _.map(this.config.accessors, accessor => {
      return {
        key: accessor.accessor,
        disabled: accessor.disabled,
        label: this.config.getLabel(undefined, accessor),
        color: this.config.getColor(accessor.accessor),
        chartType: config.chartTypes ? accessor.chart : undefined,
        axis: accessor.axis,
        shape: accessor.shape,
      }
    })
    actionman.fire('ToggleVisibility', legendId, true, data, config)
  }
  /**
   * If bucket is specified for this component perform scatterplot data bundling for Bucket
   */
  _cluster () {
    const bucketId = this.config.get('bucket')
    if (!bucketId) return
    const points = []

    const scatterPlots = this._composite.getByType('ScatterPlot')
    _.each(scatterPlots, component => {
      // TODO performance optimization: cluster only visible points
      points.push(...component.prepareData())
    })

    const config = {
      clip: `${this.id}-${this.selectors.clip}`,
      margin: this.config.margin,
      update: this.id,
      xAccessor: this.config.get('plot.x.accessor'),
    }
    // TODO performance optimization: do not calculate cluster on Zoom action if start-end distance didn't change
    actionman.fire('ToggleVisibility', this.config.get('bucket'), true, points, config)
  }

  // Event handlers

  _onMousemove (d, el, e) {
    const point = d3Selection.mouse(this.el)
    if (!this._ticking) {
      window.requestAnimationFrame(this._toggleCrosshair.bind(this, point))
      this._ticking = true
    }
  }
}
